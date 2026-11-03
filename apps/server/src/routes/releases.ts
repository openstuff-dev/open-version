import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Environment, EVERYONE, type Release, WRITERS } from '@open-version/contracts';
import { teamAccess } from '../auth.js';
import { type Pool, withScope } from '../db.js';
import { HttpError } from '../errors.js';
import { loadEnvironment, publishRelease, RELEASE_JSON, rollback } from '../model.js';
import { idParam, notes, slug, uuid, version } from './shared.js';

export const publishBody = z
  .object({
    version: version.optional(),
    bump: z.enum(['major', 'minor', 'patch']).optional(),
    notes: notes.optional(),
    hard: z.boolean().optional(),
  })
  .refine((b) => !(b.version && b.bump), 'Give a version or a bump, not both.');

export function registerReleaseRoutes(app: FastifyInstance, pool: Pool): void {
  /** The release history of an environment, newest first. */
  app.get('/api/t/:team/environments/:id/releases', async (request): Promise<Release[]> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, EVERYONE);
    return withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ release: Release }>(
        `SELECT ${RELEASE_JSON} AS release FROM releases r WHERE r.environment_id = $1
          ORDER BY r.created_at DESC, r.id LIMIT 200`,
        [id],
      );
      return rows.map((r) => r.release);
    });
  });

  app.post('/api/t/:team/environments/:id/releases', async (request, reply): Promise<Environment> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId, account } = await teamAccess(pool, request, team, WRITERS);
    const body = publishBody.parse(request.body ?? {});
    const env = await withScope(pool, { teamId }, async (db) => {
      await publishRelease(db, id, body, 'web', account.name || account.email);
      return loadEnvironment(db, id);
    });
    void reply.code(201);
    return env;
  });

  /** Make live: roll back to (or forward to) an earlier release. */
  app.post('/api/t/:team/releases/:id/live', async (request): Promise<Environment> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId, account } = await teamAccess(pool, request, team, WRITERS);
    return withScope(pool, { teamId }, async (db) => {
      const result = await rollback(db, id, account.name || account.email);
      return loadEnvironment(db, result.environmentId);
    });
  });

  /** Tries to post a release's notes to an integration again, now. */
  app.post('/api/t/:team/releases/:id/deliveries/:integration/retry', async (request): Promise<{ ok: true }> => {
    const params = z.object({ team: slug, id: uuid, integration: uuid }).parse(request.params);
    const { teamId } = await teamAccess(pool, request, params.team, WRITERS);
    await withScope(pool, { teamId }, async (db) => {
      const result = await db.query(
        `INSERT INTO outbox (team_id, integration_id, release_id)
         SELECT $1, i.id, r.id FROM integrations i JOIN releases r ON r.environment_id = i.environment_id
          WHERE i.id = $3 AND r.id = $2
         ON CONFLICT (integration_id, release_id) DO UPDATE
           SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
           WHERE outbox.status <> 'sent'`,
        [teamId, params.id, params.integration],
      );
      if (!result.rowCount) {
        throw new HttpError(409, 'These notes were already posted, or the release or integration wasn’t found.');
      }
    });
    return { ok: true };
  });
}
