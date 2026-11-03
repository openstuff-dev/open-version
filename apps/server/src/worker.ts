import type { FastifyBaseLogger } from 'fastify';
import type { Vault } from './crypto.js';
import { type Pool, withScope } from './db.js';
import { PostError, postToOpenAnnounce, type ReleasePost } from './openannounce.js';
import type { FetchPolicy } from './safe-fetch.js';

/** Tries per post before it shows as failed (Retry in the dashboard starts over). */
export const MAX_ATTEMPTS = 5;

export type Poster = (url: string, key: string, release: ReleasePost) => Promise<void>;

interface Due extends ReleasePost {
  id: string;
  attempts: number;
  url: string;
  sealed: string;
}

/**
 * Posts what's waiting in the outbox. Rows are leased first (next try moved 2 minutes ahead),
 * so two servers never post the same row at once; OpenAnnounce's Idempotency-Key covers the
 * rest. Failures back off 1, 2, 4, 8 minutes; after MAX_ATTEMPTS, or at once when retrying
 * can't help (a refused key), the row is `failed` with the reason.
 */
export async function sendOutbox(
  pool: Pool,
  vault: Vault,
  post: Poster,
  limit = 20,
): Promise<number> {
  const due = await withScope(pool, { bypass: true }, async (db) =>
    (
      await db.query<Due>(
        `UPDATE outbox o SET next_attempt_at = now() + interval '2 minutes'
           FROM integrations i, releases r, environments e, apps a
          WHERE o.id IN (
                  SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= now()
                   ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
            AND i.id = o.integration_id AND i.enabled AND i.publish_key_encrypted IS NOT NULL
            AND r.id = o.release_id AND e.id = r.environment_id AND a.id = e.app_id
          RETURNING o.id, o.attempts, i.url, i.publish_key_encrypted AS sealed, i.groups,
                    r.id AS "releaseId", a.name AS app, r.version, r.notes`,
        [limit],
      )
    ).rows,
  );
  let sent = 0;
  for (const row of due) {
    try {
      await post(row.url, vault.open(row.sealed), row);
      await withScope(pool, { bypass: true }, (db) =>
        db.query(
          `UPDATE outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL
            WHERE id = $1`,
          [row.id],
        ),
      );
      sent++;
    } catch (err) {
      const retry = err instanceof PostError ? err.retry : false;
      const attempts = row.attempts + 1;
      const failed = !retry || attempts >= MAX_ATTEMPTS;
      await withScope(pool, { bypass: true }, (db) =>
        db.query(
          `UPDATE outbox SET attempts = $2, last_error = $3,
             status = CASE WHEN $4 THEN 'failed'::outbox_status ELSE 'pending'::outbox_status END,
             next_attempt_at = now() + make_interval(mins => power(2, $2 - 1)::int)
           WHERE id = $1`,
          [row.id, attempts, (err as Error).message.slice(0, 500), failed],
        ),
      );
    }
  }
  return sent;
}

/** Deletes version-check counters older than an hour and idempotency keys older than a day. */
export async function cleanUp(pool: Pool): Promise<void> {
  await withScope(pool, { bypass: true }, async (db) => {
    await db.query(`DELETE FROM client_pings WHERE minute < now() - interval '1 hour'`);
    await db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  });
}

/**
 * Runs the outbox every 10 seconds and the cleanup every 10 minutes. Returns a function that
 * stops it.
 */
export function startWorker(
  pool: Pool,
  vault: () => Promise<Vault>,
  policy: FetchPolicy,
  log: FastifyBaseLogger,
): () => void {
  const busy = new Set<string>();
  const run = (what: string, job: () => Promise<unknown>) => async () => {
    if (busy.has(what)) return;
    busy.add(what);
    try {
      await job();
    } catch (err) {
      log.warn({ err }, `The ${what} job failed; it runs again soon.`);
    } finally {
      busy.delete(what);
    }
  };
  const poster: Poster = (url, key, release) => postToOpenAnnounce(policy, url, key, release);
  const outbox = run('outbox', async () => sendOutbox(pool, await vault(), poster));
  const cleanup = run('cleanup', () => cleanUp(pool));
  const timers = [
    setInterval(() => void outbox(), 10_000),
    setInterval(() => void cleanup(), 10 * 60_000),
  ];
  void cleanup();
  void outbox();
  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
