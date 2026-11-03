import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sha256 } from './crypto.js';
import type { Pool } from './db.js';
import { HttpError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    idempotency: { caller: string; key: string } | null;
  }
}

/** Who is asking: a person, or the environment a deploy token belongs to. */
function callerOf(request: FastifyRequest): string | null {
  if (request.deploy) return `deploy:${request.deploy.environmentId}`;
  if (request.account) return `account:${request.account.id}`;
  return null;
}

/**
 * POSTs with an Idempotency-Key header run once per caller and key: a retry from CI or a double
 * click gets the first answer back instead of publishing twice. Kept in the database for a day
 * (the worker deletes older ones), so it holds across restarts and replicas.
 */
export function registerIdempotency(app: FastifyInstance, pool: Pool): void {
  app.decorateRequest('idempotency', null);

  // After the auth hook, so the caller is known.
  app.addHook('preHandler', async (request, reply) => {
    const header = request.headers['idempotency-key'];
    const caller = callerOf(request);
    if (request.method !== 'POST' || typeof header !== 'string' || !header || !caller) return;
    const key = header.slice(0, 200);
    const hash = sha256(`${request.url}\n${JSON.stringify(request.body ?? null)}`);
    // A key older than a day counts as new: the row is taken over and the request runs.
    const { rows } = await pool.query<{
      fresh: boolean;
      status: number | null;
      body: string | null;
      request_hash: string;
    }>(
      `INSERT INTO idempotency_keys AS k (caller, key, path, request_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (caller, key) DO UPDATE SET
         path = CASE WHEN k.created_at < now() - interval '24 hours' THEN EXCLUDED.path ELSE k.path END,
         request_hash = CASE WHEN k.created_at < now() - interval '24 hours' THEN EXCLUDED.request_hash ELSE k.request_hash END,
         status = CASE WHEN k.created_at < now() - interval '24 hours' THEN NULL ELSE k.status END,
         body = CASE WHEN k.created_at < now() - interval '24 hours' THEN NULL ELSE k.body END,
         created_at = CASE WHEN k.created_at < now() - interval '24 hours' THEN now() ELSE k.created_at END
       RETURNING (xmax = 0 OR created_at = now()) AS fresh, status, body, request_hash`,
      [caller, key, request.url, hash],
    );
    const row = rows[0];
    if (row.fresh) {
      request.idempotency = { caller, key };
      return;
    }
    if (row.request_hash !== hash) {
      throw new HttpError(422, 'This Idempotency-Key was already used for a different request. Use a new key.');
    }
    if (row.status === null) throw new HttpError(409, 'That request is still running. Try again in a moment.');
    void reply.header('Idempotent-Replayed', 'true').code(row.status).type('application/json');
    return reply.send(row.body);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const entry = request.idempotency;
    if (!entry) return payload;
    request.idempotency = null;
    // A server error may not have changed anything, so let the retry run again.
    if (reply.statusCode >= 500) {
      await pool.query('DELETE FROM idempotency_keys WHERE caller = $1 AND key = $2', [entry.caller, entry.key]);
    } else {
      await pool.query('UPDATE idempotency_keys SET status = $3, body = $4 WHERE caller = $1 AND key = $2', [
        entry.caller,
        entry.key,
        reply.statusCode,
        typeof payload === 'string' ? payload : null,
      ]);
    }
    return payload;
  });
}
