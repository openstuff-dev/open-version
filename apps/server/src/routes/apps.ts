import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type AppSummary,
  type Environment,
  type EnvironmentWithToken,
  EVERYONE,
  type NewApp,
  WRITERS,
} from '@open-version/contracts';
import { teamAccess } from '../auth.js';
import { newPublicKey } from '../crypto.js';
import { type Client, type Pool, withScope } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { deployTokenColumns, hardRefresh, loadEnvironment, RECENT_CHECKS } from '../model.js';
import { baseUrl, environmentName, idParam, name, origin, slug, slugify, teamParam } from './shared.js';

const APP_SUMMARY = `json_build_object('id', a.id, 'slug', a.slug, 'name', a.name, 'baseUrl', a.base_url,
  'environments', coalesce((SELECT json_agg(json_build_object(
      'id', e.id, 'name', e.name, 'liveVersion', r.version, 'liveHard', coalesce(r.hard, false),
      'lastReleasedAt', r.created_at, 'recentChecks', ${RECENT_CHECKS})
    -- production first, then by name
    ORDER BY e.name <> 'production', e.name)
    FROM environments e LEFT JOIN releases r ON r.id = e.live_release_id WHERE e.app_id = a.id), '[]'))`;

async function createEnvironment(
  db: Client,
  teamId: string,
  appId: string,
  envName: string,
  origins: string[],
): Promise<EnvironmentWithToken> {
  const token = deployTokenColumns(envName);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO environments (team_id, app_id, name, public_key, deploy_token_hash, deploy_token_prefix,
       deploy_token_last4, allowed_origins)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [teamId, appId, envName, newPublicKey(), token.hash, token.prefix, token.last4, origins],
  );
  return { ...(await loadEnvironment(db, rows[0].id)), deployToken: token.token };
}

export function registerAppRoutes(app: FastifyInstance, pool: Pool): void {
  /** The Apps page: every app with its environments, in one query. */
  app.get('/api/t/:team/apps', async (request): Promise<AppSummary[]> => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, EVERYONE);
    return withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ app: AppSummary }>(`SELECT ${APP_SUMMARY} AS app FROM apps a ORDER BY a.name`);
      return rows.map((r) => r.app);
    });
  });

  app.post('/api/t/:team/apps', async (request, reply): Promise<NewApp> => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, WRITERS);
    const body = z
      .object({
        name,
        slug: slug.optional(),
        baseUrl,
        environments: z.array(environmentName).min(1, 'Pick at least one environment.').max(10).default(['production']),
      })
      .parse(request.body);
    const result = await withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        'INSERT INTO apps (team_id, slug, name, base_url) VALUES ($1, $2, $3, $4) RETURNING id',
        [teamId, body.slug ?? slugify(body.name), body.name, body.baseUrl],
      );
      const appId = rows[0].id;
      // The base URL's origin may check the version from the start.
      const origins = [new URL(body.baseUrl).origin];
      const environments: EnvironmentWithToken[] = [];
      for (const envName of [...new Set(body.environments)]) {
        environments.push(await createEnvironment(db, teamId, appId, envName, origins));
      }
      const summary = await db.query<{ app: AppSummary }>(`SELECT ${APP_SUMMARY} AS app FROM apps a WHERE a.id = $1`, [appId]);
      return { app: summary.rows[0].app, environments };
    });
    void reply.code(201);
    return result;
  });

  app.patch('/api/t/:team/apps/:id', async (request): Promise<AppSummary> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, WRITERS);
    const body = z
      .object({ name: name.optional(), baseUrl: baseUrl.optional() })
      .parse(request.body);
    return withScope(pool, { teamId }, async (db) => {
      const result = await db.query(
        'UPDATE apps SET name = coalesce($2, name), base_url = coalesce($3, base_url) WHERE id = $1',
        [id, body.name ?? null, body.baseUrl ?? null],
      );
      if (!result.rowCount) throw notFound('That app');
      const { rows } = await db.query<{ app: AppSummary }>(`SELECT ${APP_SUMMARY} AS app FROM apps a WHERE a.id = $1`, [id]);
      return rows[0].app;
    });
  });

  app.delete('/api/t/:team/apps/:id', async (request): Promise<{ ok: true }> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    await withScope(pool, { teamId }, (db) => db.query('DELETE FROM apps WHERE id = $1', [id]));
    return { ok: true };
  });

  /** One environment by its app's slug and its name, as the web app's URLs have them. */
  app.get('/api/t/:team/apps/:app/environments/:env', async (request): Promise<Environment> => {
    const params = z.object({ team: slug, app: slug, env: environmentName }).parse(request.params);
    const { teamId } = await teamAccess(pool, request, params.team, EVERYONE);
    return withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        'SELECT e.id FROM environments e JOIN apps a ON a.id = e.app_id WHERE a.slug = $1 AND e.name = $2',
        [params.app, params.env],
      );
      const row = rows.at(0);
      if (!row) throw notFound('That environment');
      return loadEnvironment(db, row.id);
    });
  });

  app.post('/api/t/:team/apps/:id/environments', async (request, reply): Promise<EnvironmentWithToken> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, WRITERS);
    const body = z.object({ name: environmentName }).parse(request.body);
    const env = await withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ baseUrl: string }>('SELECT base_url AS "baseUrl" FROM apps WHERE id = $1', [id]);
      const found = rows.at(0);
      if (!found) throw notFound('That app');
      return createEnvironment(db, teamId, id, body.name, [new URL(found.baseUrl).origin]);
    });
    void reply.code(201);
    return env;
  });

  app.patch('/api/t/:team/environments/:id', async (request): Promise<Environment> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, WRITERS);
    const body = z
      .object({
        name: environmentName.optional(),
        allowedOrigins: z.array(origin).max(50).optional(),
        refreshPolicy: z.enum(['prompt', 'force']).optional(),
      })
      .parse(request.body);
    return withScope(pool, { teamId }, async (db) => {
      const result = await db.query(
        `UPDATE environments SET name = coalesce($2, name), allowed_origins = coalesce($3, allowed_origins),
           refresh_policy = coalesce($4::refresh_policy, refresh_policy) WHERE id = $1`,
        [
          id,
          body.name ?? null,
          body.allowedOrigins ? [...new Set(body.allowedOrigins)] : null,
          body.refreshPolicy ?? null,
        ],
      );
      if (!result.rowCount) throw notFound('That environment');
      return loadEnvironment(db, id);
    });
  });

  app.delete('/api/t/:team/environments/:id', async (request): Promise<{ ok: true }> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    await withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ others: number }>(
        `SELECT count(*)::int AS others FROM environments
          WHERE app_id = (SELECT app_id FROM environments WHERE id = $1) AND id <> $1`,
        [id],
      );
      if (rows[0].others === 0) {
        throw new HttpError(409, 'This is the app’s only environment. Delete the app instead.');
      }
      await db.query('DELETE FROM environments WHERE id = $1', [id]);
    });
    return { ok: true };
  });

  /** A new deploy token, shown this once. The old one stops working at once. */
  app.post('/api/t/:team/environments/:id/token', async (request): Promise<EnvironmentWithToken> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, WRITERS);
    return withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ name: string }>('SELECT name FROM environments WHERE id = $1', [id]);
      const env = rows.at(0);
      if (!env) throw notFound('That environment');
      const token = deployTokenColumns(env.name);
      await db.query(
        `UPDATE environments SET deploy_token_hash = $2, deploy_token_prefix = $3, deploy_token_last4 = $4 WHERE id = $1`,
        [id, token.hash, token.prefix, token.last4],
      );
      return { ...(await loadEnvironment(db, id)), deployToken: token.token };
    });
  });

  /** Hard refresh: every open tab reloads once, without a new release. */
  app.post('/api/t/:team/environments/:id/refresh', async (request): Promise<Environment> => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, WRITERS);
    return withScope(pool, { teamId }, async (db) => {
      await hardRefresh(db, id);
      return loadEnvironment(db, id);
    });
  });
}
