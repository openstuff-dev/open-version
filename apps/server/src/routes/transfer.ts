import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TeamExport } from '@open-version/contracts';
import { teamAccess } from '../auth.js';
import { newPublicKey } from '../crypto.js';
import { type Pool, withScope } from '../db.js';
import { deployTokenColumns } from '../model.js';
import { environmentName, name, notes, slug, teamParam, version } from './shared.js';

export const EXPORT_NOTE =
  'Public keys, deploy tokens and integration publish keys are not in this file. Imported environments get new keys and tokens; enter integration keys again.';

const importFile = z.object({
  format: z.literal('openversion-export'),
  version: z.literal(1),
  apps: z
    .array(
      z.object({
        slug,
        name,
        baseUrl: z.string().regex(/^https?:\/\//),
        environments: z
          .array(
            z.object({
              name: environmentName,
              allowedOrigins: z.array(z.string()).max(50).default([]),
              refreshPolicy: z.enum(['prompt', 'force']).default('prompt'),
              releases: z
                .array(
                  z.object({
                    version,
                    notes: notes.default(''),
                    hard: z.boolean().default(false),
                    source: z.enum(['cli', 'api', 'web']).default('api'),
                    createdAt: z.string(),
                    live: z.boolean().default(false),
                  }),
                )
                .max(5000),
              integrations: z
                .array(
                  z.object({
                    kind: z.literal('open-announce'),
                    url: z.string().regex(/^https?:\/\//),
                    groups: z.array(slug).default([]),
                    enabled: z.boolean().default(true),
                  }),
                )
                .max(10)
                .default([]),
            }),
          )
          .max(20),
      }),
    )
    .max(500),
});

/** Everything a team holds, as one JSON file, and back. People own their data. */
export function registerTransferRoutes(app: FastifyInstance, pool: Pool): void {
  app.get('/api/t/:team/export', async (request, reply): Promise<TeamExport> => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const data = await withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ data: TeamExport }>(
        `SELECT json_build_object(
          'format', 'openversion-export', 'version', 1, 'exportedAt', now(), 'note', $2::text,
          'team', (SELECT json_build_object('slug', slug, 'name', name) FROM teams WHERE id = $1),
          'apps', coalesce((SELECT json_agg(json_build_object(
            'slug', a.slug, 'name', a.name, 'baseUrl', a.base_url,
            'environments', coalesce((SELECT json_agg(json_build_object(
              'name', e.name, 'allowedOrigins', e.allowed_origins, 'refreshPolicy', e.refresh_policy,
              'releases', coalesce((SELECT json_agg(json_build_object(
                'version', r.version, 'notes', r.notes, 'hard', r.hard, 'source', r.source,
                'createdAt', r.created_at,
                'live', r.id = (SELECT coalesce(l.rollback_of, l.id) FROM releases l WHERE l.id = e.live_release_id))
                ORDER BY r.created_at) FROM releases r WHERE r.environment_id = e.id AND r.rollback_of IS NULL), '[]'),
              'integrations', coalesce((SELECT json_agg(json_build_object(
                'kind', i.kind, 'url', i.url, 'groups', i.groups, 'enabled', i.enabled))
                FROM integrations i WHERE i.environment_id = e.id), '[]'))
              ORDER BY e.name) FROM environments e WHERE e.app_id = a.id), '[]'))
            ORDER BY a.slug) FROM apps a), '[]')
        ) AS data`,
        [teamId, EXPORT_NOTE],
      );
      return rows[0].data;
    });
    void reply.header('Content-Disposition', `attachment; filename="openversion-${team}.json"`);
    return data;
  });

  /**
   * Adds what's in an export to this team. Apps and environments it already has (by slug and
   * name) are updated; releases it already has are skipped. New environments get new keys.
   */
  app.post('/api/t/:team/import', { bodyLimit: 20 * 1024 * 1024 }, async (request) => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const file = importFile.parse(request.body);
    return withScope(pool, { teamId }, async (db) => {
      let releases = 0;
      let environments = 0;
      for (const a of file.apps) {
        const { rows: apps } = await db.query<{ id: string }>(
          `INSERT INTO apps (team_id, slug, name, base_url) VALUES ($1, $2, $3, $4)
           ON CONFLICT (team_id, slug) DO UPDATE SET name = EXCLUDED.name, base_url = EXCLUDED.base_url
           RETURNING id`,
          [teamId, a.slug, a.name, a.baseUrl],
        );
        const appId = apps[0].id;
        for (const e of a.environments) {
          const token = deployTokenColumns(e.name);
          const { rows: envs } = await db.query<{ id: string }>(
            `INSERT INTO environments (team_id, app_id, name, public_key, deploy_token_hash, deploy_token_prefix,
               deploy_token_last4, allowed_origins, refresh_policy)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (app_id, name) DO UPDATE SET allowed_origins = EXCLUDED.allowed_origins,
               refresh_policy = EXCLUDED.refresh_policy
             RETURNING id`,
            [
              teamId,
              appId,
              e.name,
              newPublicKey(),
              token.hash,
              token.prefix,
              token.last4,
              e.allowedOrigins,
              e.refreshPolicy,
            ],
          );
          const envId = envs[0].id;
          environments++;
          if (e.releases.length > 0) {
            const { rowCount } = await db.query(
              `INSERT INTO releases (team_id, environment_id, version, notes, hard, source, created_by, created_at)
               SELECT $1, $2, x.version, x.notes, x.hard, x.source::release_source, 'Import', x."createdAt"::timestamptz
                 FROM json_to_recordset($3::json) AS x(version text, notes text, hard boolean, source text, "createdAt" text)
               ON CONFLICT (environment_id, version) WHERE rollback_of IS NULL DO NOTHING`,
              [teamId, envId, JSON.stringify(e.releases)],
            );
            releases += rowCount ?? 0;
            const live = e.releases.find((r) => r.live);
            if (live) {
              await db.query(
                `UPDATE environments SET live_release_id = (SELECT id FROM releases
                   WHERE environment_id = $1 AND version = $2 AND rollback_of IS NULL) WHERE id = $1`,
                [envId, live.version],
              );
            }
          }
          for (const i of e.integrations) {
            await db.query(
              `INSERT INTO integrations (team_id, environment_id, kind, url, groups, enabled)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (environment_id, kind) DO UPDATE SET url = EXCLUDED.url, groups = EXCLUDED.groups`,
              [teamId, envId, i.kind, i.url, i.groups, i.enabled],
            );
          }
        }
      }
      return { apps: file.apps.length, environments, releases, note: EXPORT_NOTE };
    });
  });
}
