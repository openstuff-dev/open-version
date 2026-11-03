import { bump, compareVersions, type Environment, type PublishRelease, type ReleaseSource } from '@open-version/contracts';
import { newDeployToken, sha256 } from './crypto.js';
import type { Client } from './db.js';
import { HttpError, notFound } from './errors.js';

/** A release as JSON, with what happened to its notes in each integration. `r` is releases. */
export const RELEASE_JSON = `json_build_object(
  'id', r.id, 'version', r.version, 'notes', r.notes, 'hard', r.hard, 'source', r.source,
  'createdBy', r.created_by, 'rollbackOf', r.rollback_of, 'createdAt', r.created_at,
  'deliveries', coalesce((SELECT json_agg(json_build_object(
      'integrationId', o.integration_id, 'kind', i.kind, 'status', o.status,
      'attempts', o.attempts, 'lastError', o.last_error) ORDER BY i.kind)
    FROM outbox o JOIN integrations i ON i.id = o.integration_id WHERE o.release_id = r.id), '[]'))`;

/** Version checks in the last 5 minutes for environment `e`: about one per open tab. */
export const RECENT_CHECKS = `coalesce((SELECT sum(p.count) FROM client_pings p
  WHERE p.environment_id = e.id AND p.minute >= date_trunc('minute', now()) - interval '4 minutes'), 0)::int`;

/** Columns of the Environment DTO, from environments `e` joined to apps `a`. */
export const ENVIRONMENT_COLUMNS = `e.id, e.app_id AS "appId", a.slug AS "appSlug", a.name AS "appName",
  a.base_url AS "baseUrl", e.name, e.public_key AS "publicKey",
  e.deploy_token_prefix || '••••' || e.deploy_token_last4 AS "tokenHint",
  e.allowed_origins AS "allowedOrigins", e.refresh_policy AS "refreshPolicy",
  e.refresh_epoch AS "refreshEpoch", ${RECENT_CHECKS} AS "recentChecks", e.created_at AS "createdAt",
  (SELECT ${RELEASE_JSON} FROM releases r WHERE r.id = e.live_release_id) AS live`;

export async function loadEnvironment(db: Client, id: string): Promise<Environment> {
  const { rows } = await db.query<Environment>(
    `SELECT ${ENVIRONMENT_COLUMNS} FROM environments e JOIN apps a ON a.id = e.app_id WHERE e.id = $1`,
    [id],
  );
  const row = rows.at(0);
  if (!row) throw notFound('That environment');
  return row;
}

/** A new deploy token and the columns that store it: only its hash and last four characters. */
export function deployTokenColumns(environment: string) {
  const token = newDeployToken(environment);
  return {
    token,
    hash: sha256(token),
    prefix: token.startsWith('ov_live_') ? 'ov_live_' : 'ov_test_',
    last4: token.slice(-4),
  };
}

interface Locked {
  id: string;
  teamId: string;
  name: string;
  live: string | null;
}

async function lockEnvironment(db: Client, environmentId: string): Promise<Locked> {
  const { rows } = await db.query<Locked>(
    `SELECT e.id, e.team_id AS "teamId", e.name, r.version AS live
       FROM environments e LEFT JOIN releases r ON r.id = e.live_release_id
      WHERE e.id = $1 FOR UPDATE OF e`,
    [environmentId],
  );
  const env = rows.at(0);
  if (!env) throw notFound('That environment');
  return env;
}

/**
 * Publishes a release and makes it live, in the caller's transaction. A version must be higher
 * than the live one (409 otherwise). Integrations get an outbox row in the same transaction, so
 * the notes are posted exactly when the release exists. Returns the new release's id.
 */
export async function publishRelease(
  db: Client,
  environmentId: string,
  input: PublishRelease,
  source: ReleaseSource,
  createdBy: string,
): Promise<string> {
  const env = await lockEnvironment(db, environmentId);
  if (input.version && input.bump) throw new HttpError(400, 'Give a version or a bump, not both.');
  const version = input.version ?? bump(env.live ?? '0.0.0', input.bump ?? 'patch');
  if (env.live && compareVersions(version, env.live) <= 0) {
    throw new HttpError(
      409,
      `${env.live} is live in ${env.name}, so publish a version higher than ${env.live}. ` +
      'To go back to an older one, make it live from the dashboard.',
    );
  }
  const taken = await db.query('SELECT 1 FROM releases WHERE environment_id = $1 AND version = $2 AND rollback_of IS NULL', [
    environmentId,
    version,
  ]);
  if (taken.rowCount) {
    throw new HttpError(
      409,
      `${version} was already published to ${env.name}. Publish a higher version, or make ${version} live from the dashboard.`,
    );
  }
  const { rows } = await db.query<{ id: string }>(
    `WITH r AS (
       INSERT INTO releases (team_id, environment_id, version, notes, hard, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id),
     live AS (UPDATE environments SET live_release_id = (SELECT id FROM r) WHERE id = $2),
     posts AS (INSERT INTO outbox (team_id, integration_id, release_id)
       SELECT $1, i.id, (SELECT id FROM r) FROM integrations i
        WHERE i.environment_id = $2 AND i.enabled AND i.publish_key_encrypted IS NOT NULL)
     SELECT id FROM r`,
    [env.teamId, environmentId, version, input.notes ?? '', input.hard ?? false, source, createdBy],
  );
  return rows[0].id;
}

/**
 * Makes an older release live again. It's recorded like a release that points at the one it
 * brought back, and it is hard: every open tab reloads to that version.
 */
export async function rollback(
  db: Client,
  releaseId: string,
  createdBy: string,
): Promise<{ id: string; environmentId: string }> {
  const { rows: found } = await db.query<{
    environmentId: string;
    target: string;
    version: string;
  }>(
    `SELECT environment_id AS "environmentId", coalesce(rollback_of, id) AS target, version
       FROM releases WHERE id = $1`,
    [releaseId],
  );
  const release = found.at(0);
  if (!release) throw notFound('That release');
  const env = await lockEnvironment(db, release.environmentId);
  if (env.live !== null && compareVersions(env.live, release.version) === 0) {
    throw new HttpError(409, `${release.version} is already live in ${env.name}.`);
  }
  const { rows } = await db.query<{ id: string }>(
    `WITH r AS (
       INSERT INTO releases (team_id, environment_id, version, notes, hard, source, created_by, rollback_of)
       VALUES ($1, $2, $3, '', true, 'web', $4, $5) RETURNING id)
     UPDATE environments SET live_release_id = (SELECT id FROM r) WHERE id = $2 RETURNING live_release_id AS id`,
    [env.teamId, env.id, release.version, createdBy, release.target],
  );
  return { id: rows[0].id, environmentId: env.id };
}

/** Every open tab of the environment reloads once. */
export async function hardRefresh(db: Client, environmentId: string): Promise<number> {
  const { rows } = await db.query<{ epoch: number }>(
    'UPDATE environments SET refresh_epoch = refresh_epoch + 1 WHERE id = $1 RETURNING refresh_epoch AS epoch',
    [environmentId],
  );
  const row = rows.at(0);
  if (!row) throw notFound('That environment');
  return row.epoch;
}
