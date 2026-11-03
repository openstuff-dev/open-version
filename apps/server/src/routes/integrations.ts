import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EVERYONE, type Integration } from '@open-version/contracts';
import { teamAccess } from '../auth.js';
import type { Vault } from '../crypto.js';
import { type Pool, withScope } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { baseUrl, idParam, slug, teamParam } from './shared.js';

const INTEGRATION_COLUMNS = `i.id, i.environment_id AS "environmentId", a.name AS "appName", a.slug AS "appSlug",
  e.name AS "environmentName", i.kind, i.url, i.publish_key_encrypted IS NOT NULL AS "hasKey", i.groups,
  i.enabled,
  (SELECT count(*)::int FROM outbox o WHERE o.integration_id = i.id AND o.status = 'failed') AS failed,
  (SELECT count(*)::int FROM outbox o WHERE o.integration_id = i.id AND o.status = 'sent') AS sent,
  (SELECT o.last_error FROM outbox o WHERE o.integration_id = i.id AND o.last_error IS NOT NULL
    ORDER BY o.created_at DESC LIMIT 1) AS "lastError"`;
const FROM = 'integrations i JOIN environments e ON e.id = i.environment_id JOIN apps a ON a.id = e.app_id';

const groups = z
  .array(slug)
  .max(50)
  .transform((list) => [...new Set(list)]);
const publishKey = z.string().trim().min(8, 'Paste the whole publish key.').max(500);

export type TestConnection = (url: string, key: string) => Promise<void>;

/** Integrations hold another system's key, so only admins manage them. Everyone sees them. */
export function registerIntegrationRoutes(
  app: FastifyInstance,
  pool: Pool,
  vault: () => Promise<Vault>,
  testConnection: TestConnection,
): void {
  const load = (teamId: string, where: string, values: unknown[]) =>
    withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<Integration>(
        `SELECT ${INTEGRATION_COLUMNS} FROM ${FROM} WHERE ${where} ORDER BY a.name, e.name <> 'production', e.name, i.kind`,
        values,
      );
      return rows;
    });

  app.get('/api/t/:team/integrations', async (request): Promise<Integration[]> => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, EVERYONE);
    return load(teamId, 'true', []);
  });

  app.get('/api/t/:team/environments/:id/integrations', async (request): Promise<Integration[]> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, EVERYONE);
    return load(teamId, 'i.environment_id = $1', [id]);
  });

  app.post('/api/t/:team/environments/:id/integrations', async (request, reply): Promise<Integration> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const body = z
      .object({
        kind: z.literal('open-announce').default('open-announce'),
        url: baseUrl,
        publishKey: publishKey.optional(),
        groups: groups.default([]),
        enabled: z.boolean().default(true),
      })
      .parse(request.body);
    const sealed = body.publishKey ? (await vault()).seal(body.publishKey) : null;
    const integrationId = await withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO integrations (team_id, environment_id, kind, url, publish_key_encrypted, groups, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [teamId, id, body.kind, body.url, sealed, body.groups, body.enabled],
      );
      return rows[0].id;
    });
    void reply.code(201);
    const [row] = await load(teamId, 'i.id = $1', [integrationId]);
    return row;
  });

  /** Changes an integration. Leave out `publishKey` to keep the saved one. */
  app.patch('/api/t/:team/integrations/:id', async (request): Promise<Integration> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const body = z
      .object({
        url: baseUrl.optional(),
        publishKey: publishKey.optional(),
        groups: groups.optional(),
        enabled: z.boolean().optional(),
      })
      .parse(request.body);
    const sealed = body.publishKey ? (await vault()).seal(body.publishKey) : null;
    const result = await withScope(pool, { teamId }, (db) =>
      db.query(
        `UPDATE integrations SET url = coalesce($2, url), publish_key_encrypted = coalesce($3, publish_key_encrypted),
           groups = coalesce($4, groups), enabled = coalesce($5, enabled) WHERE id = $1`,
        [id, body.url ?? null, sealed, body.groups ?? null, body.enabled ?? null],
      ),
    );
    if (!result.rowCount) throw notFound('That integration');
    const [row] = await load(teamId, 'i.id = $1', [id]);
    return row;
  });

  app.delete('/api/t/:team/integrations/:id', async (request): Promise<{ ok: true }> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    await withScope(pool, { teamId }, (db) => db.query('DELETE FROM integrations WHERE id = $1', [id]));
    return { ok: true };
  });

  /**
   * Checks the URL and key against the other system now. Takes a URL and key from the form, or
   * uses the saved ones, so people can test before they save.
   */
  app.post('/api/t/:team/integrations/:id/test', async (request): Promise<{ ok: true }> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const body = z
      .object({ url: baseUrl.optional(), publishKey: publishKey.optional() })
      .parse(request.body ?? {});
    const saved = await withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ url: string; sealed: string | null }>(
        'SELECT url, publish_key_encrypted AS sealed FROM integrations WHERE id = $1',
        [id],
      );
      return rows.at(0);
    });
    if (!saved) throw notFound('That integration');
    const key = body.publishKey ?? (saved.sealed ? (await vault()).open(saved.sealed) : null);
    if (!key) throw new HttpError(400, 'Enter the OpenAnnounce publish key first.');
    try {
      await testConnection(body.url ?? saved.url, key);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    return { ok: true };
  });
}
