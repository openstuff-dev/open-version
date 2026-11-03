import type { FastifyBaseLogger } from 'fastify';
import { type Pool, withScope } from './db.js';

/** Deletes version-check counters older than an hour and idempotency keys older than a day. */
export async function cleanUp(pool: Pool): Promise<void> {
  await withScope(pool, { bypass: true }, async (db) => {
    await db.query(`DELETE FROM client_pings WHERE minute < now() - interval '1 hour'`);
    await db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  });
}

/** Runs the cleanup every 10 minutes. Returns a function that stops it. */
export function startWorker(pool: Pool, log: FastifyBaseLogger): () => void {
  let busy = false;
  const run = (job: () => Promise<unknown>, what: string) => async () => {
    if (busy) return;
    busy = true;
    try {
      await job();
    } catch (err) {
      log.warn({ err }, `The ${what} job failed; it runs again soon.`);
    } finally {
      busy = false;
    }
  };
  const cleanup = run(() => cleanUp(pool), 'cleanup');
  const timer = setInterval(() => void cleanup(), 10 * 60_000);
  void cleanup();
  return () => {
    clearInterval(timer);
  };
}
