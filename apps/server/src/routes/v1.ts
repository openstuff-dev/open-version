import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { PublishedRelease, RefreshPolicy, VersionInfo } from '@open-version/contracts';
import { requireDeploy } from '../auth.js';
import type { Config } from '../config.js';
import { type Client, type Pool, scopeSql, withScope } from '../db.js';
import { hardRefresh, publishRelease } from '../model.js';
import { publishBody } from './releases.js';

interface Row {
  allowed: boolean;
  version: string | null;
  hard: boolean | null;
  epoch: number;
  policy: RefreshPolicy;
  releasedAt: string | null;
  releaseId: string | null;
  hasNotes: boolean | null;
}

/**
 * Looks up the key, checks the origin, counts the ping and reads the live release in one round
 * trip: every open tab calls this every few minutes. Values are inlined as escaped literals, so
 * the transaction, the scope and the query can share one multi-statement query.
 */
async function versionRow(
  pool: Pool,
  key: string,
  origin: string | undefined,
): Promise<Row | null> {
  const client = await pool.connect();
  try {
    const lit = (v: string) => client.escapeLiteral(v);
    const results = (await client.query(`BEGIN; ${scopeSql(client, { bypass: true })};
      WITH env AS (
        SELECT e.id, e.team_id, e.refresh_epoch, e.refresh_policy, e.live_release_id,
               (${origin === undefined ? 'true' : `cardinality(e.allowed_origins) = 0 OR ${lit(origin)} = ANY(e.allowed_origins)`}) AS allowed
          FROM environments e WHERE e.public_key = ${lit(key)}),
      ping AS (
        INSERT INTO client_pings (team_id, environment_id, minute, count)
        SELECT team_id, id, date_trunc('minute', now()), 1 FROM env WHERE allowed
        ON CONFLICT (environment_id, minute) DO UPDATE SET count = client_pings.count + 1)
      SELECT env.allowed, r.version, r.hard, env.refresh_epoch AS epoch, env.refresh_policy AS policy,
             r.created_at AS "releasedAt", coalesce(r.rollback_of, r.id) AS "releaseId",
             (SELECT notes <> '' FROM releases n WHERE n.id = coalesce(r.rollback_of, r.id)) AS "hasNotes"
        FROM env LEFT JOIN releases r ON r.id = env.live_release_id;
      COMMIT;`)) as unknown as pg.QueryResult<Row>[];
    // Results: BEGIN, the scope, the query, COMMIT.
    return results[2].rows.at(0) ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Checks per public key and address, per minute, in this process. */
function rateLimiter(perMinute: number) {
  const windows = new Map<string, { count: number; until: number }>();
  return (key: string): number | null => {
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry || entry.until <= now) {
      if (windows.size > 50_000) windows.clear();
      windows.set(key, { count: 1, until: now + 60_000 });
      return null;
    }
    entry.count++;
    return entry.count > perMinute ? Math.ceil((entry.until - now) / 1000) : null;
  };
}

const ERROR = { type: 'object', properties: { error: { type: 'string' } } } as const;
const RELEASE = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    version: { type: 'string', examples: ['1.4.2'] },
    hard: { type: 'boolean' },
    notes: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    app: { type: 'string' },
    environment: { type: 'string' },
  },
} as const;
const BEARER = [{ deployToken: [] }];

async function liveRelease(db: Client, environmentId: string): Promise<PublishedRelease | null> {
  const { rows } = await db.query<PublishedRelease>(
    `SELECT r.id, r.version, r.hard, coalesce(o.notes, r.notes) AS notes, r.created_at AS "createdAt",
            a.name AS app, e.name AS environment
       FROM environments e JOIN apps a ON a.id = e.app_id
       JOIN releases r ON r.id = e.live_release_id LEFT JOIN releases o ON o.id = r.rollback_of
      WHERE e.id = $1`,
    [environmentId],
  );
  return rows.at(0) ?? null;
}

/** The public version endpoint and the CI API. */
export function registerV1Routes(app: FastifyInstance, pool: Pool, config: Config): void {
  const limited = rateLimiter(config.versionRateLimit);

  // A preflight (the client sends If-None-Match) carries no key, so it says yes; the GET then
  // only lets the environment's own origins read the answer.
  app.options('/api/v1/version', { schema: { hide: true } }, (request, reply) => {
    void reply
      .header('Access-Control-Allow-Origin', request.headers.origin ?? '*')
      .header('Access-Control-Allow-Methods', 'GET')
      .header('Access-Control-Allow-Headers', 'If-None-Match')
      .header('Access-Control-Max-Age', '600')
      .header('Vary', 'Origin')
      .code(204)
      .send();
  });

  app.get(
    '/api/v1/version',
    {
      schema: {
        summary: 'The live version of an environment, for open tabs',
        description:
          'Called by @openstuff-dev/version. Answers 304 when If-None-Match matches. Each call counts as one check for the live dot.',
        querystring: { type: 'object', required: ['key'], properties: { key: { type: 'string', description: 'The public key, pk_…' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              version: { type: ['string', 'null'] },
              hard: { type: 'boolean' },
              epoch: { type: 'integer' },
              policy: { type: 'string', enum: ['prompt', 'force'] },
              releasedAt: { type: ['string', 'null'], format: 'date-time' },
              notesUrl: { type: ['string', 'null'] },
            },
          },
          304: { type: 'null', description: 'Unchanged since the ETag in If-None-Match' },
          401: ERROR,
          403: ERROR,
          429: ERROR,
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: { key?: string } }>, reply: FastifyReply) => {
      const origin = request.headers.origin;
      void reply.header('Vary', 'Origin').header('Access-Control-Expose-Headers', 'ETag');
      if (origin) void reply.header('Access-Control-Allow-Origin', origin);
      const key = request.query.key ?? '';
      if (!/^pk_[\w-]{10,60}$/.test(key)) {
        return reply.code(401).send({ error: 'Send the environment’s public key as ?key=pk_….' });
      }
      const wait = limited(`${key}|${request.ip}`);
      if (wait !== null) {
        return reply.code(429).header('Retry-After', String(wait)).send({ error: 'Too many version checks. Try again in a minute.' });
      }
      const row = await versionRow(pool, key, origin);
      if (!row) return reply.code(401).send({ error: 'That public key doesn’t belong to any environment.' });
      if (!row.allowed) {
        void reply.removeHeader('Access-Control-Allow-Origin');
        return reply.code(403).send({ error: `${origin ?? 'This origin'} isn’t one of this environment’s allowed origins.` });
      }
      const info: VersionInfo = {
        version: row.version,
        hard: row.hard ?? false,
        epoch: row.epoch,
        policy: row.policy,
        releasedAt: row.releasedAt ? new Date(row.releasedAt).toISOString() : null,
        notesUrl: row.hasNotes && row.releaseId ? `${config.publicUrl}/notes/${row.releaseId}` : null,
      };
      const body = JSON.stringify(info);
      const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;
      void reply.header('ETag', etag).header('Cache-Control', 'no-cache');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.type('application/json; charset=utf-8').send(body);
    },
  );

  app.get(
    '/api/v1/releases/live',
    {
      schema: {
        summary: 'The live release of the deploy token’s environment',
        security: BEARER,
        response: { 200: { anyOf: [RELEASE, { type: 'null' }] }, 401: ERROR },
      },
    },
    async (request) => {
      const caller = requireDeploy(request);
      return withScope(pool, { teamId: caller.teamId }, (db) =>
        liveRelease(db, caller.environmentId),
      );
    },
  );

  app.post(
    '/api/v1/releases',
    {
      schema: {
        summary: 'Publish a release and make it live',
        description:
          'Give `version`, or `bump` to go up from the live version (default patch). The version must be higher than the live one, or the answer is 409 with the live version in the message. Send an Idempotency-Key (the commit SHA) so a retried job publishes once.',
        security: BEARER,
        headers: { type: 'object', properties: { 'idempotency-key': { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            version: { type: 'string', examples: ['1.4.2'] },
            bump: { type: 'string', enum: ['major', 'minor', 'patch'] },
            notes: { type: 'string', description: 'Markdown' },
            hard: { type: 'boolean', description: 'Reload every open tab without asking' },
          },
        },
        response: { 201: RELEASE, 400: ERROR, 401: ERROR, 409: ERROR },
      },
    },
    async (request, reply) => {
      const caller = requireDeploy(request);
      const body = publishBody.parse(request.body ?? {});
      const source = (request.headers['user-agent'] ?? '').includes('openversion-cli') ? 'cli' : 'api';
      const release = await withScope(pool, { teamId: caller.teamId }, async (db) => {
        await publishRelease(db, caller.environmentId, body, source, 'Deploy token');
        return liveRelease(db, caller.environmentId);
      });
      void reply.code(201);
      return release;
    },
  );

  app.post(
    '/api/v1/refresh',
    {
      schema: {
        summary: 'Hard refresh: every open tab reloads once',
        security: BEARER,
        response: { 200: { type: 'object', properties: { epoch: { type: 'integer' } } }, 401: ERROR },
      },
    },
    async (request) => {
      const caller = requireDeploy(request);
      const epoch = await withScope(pool, { teamId: caller.teamId }, (db) =>
        hardRefresh(db, caller.environmentId),
      );
      return { epoch };
    },
  );

  /** What changed in a release, as a plain page the "What's new" link opens. */
  app.get('/notes/:id', { schema: { hide: true } }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { rows } = await withScope(pool, { bypass: true }, (db) =>
      db.query<{ app: string; version: string; notes: string; createdAt: Date }>(
        `SELECT a.name AS app, r.version, r.notes, r.created_at AS "createdAt"
           FROM releases r JOIN environments e ON e.id = r.environment_id JOIN apps a ON a.id = e.app_id
          WHERE r.id = $1 AND r.notes <> ''`,
        [id],
      ),
    );
    const release = rows.at(0);
    if (!release) return reply.code(404).type('text/plain').send('These release notes weren’t found.');
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(notesPage(release));
  });
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** A small, safe page: the notes are text, with paragraphs, list items and headings kept. */
interface NotesRelease {
  app: string;
  version: string;
  notes: string;
  createdAt: Date;
}

function notesPage(release: NotesRelease): string {
  const blocks = release.notes
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${escapeHtml(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(block.trim());
      if (heading && lines.length === 1) return `<h2>${escapeHtml(heading[2])}</h2>`;
      return `<p>${escapeHtml(block.trim()).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  const title = `${escapeHtml(release.app)} ${escapeHtml(release.version)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What’s new in ${title}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.55; }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; text-wrap: balance; }
  h2 { font-size: 1.125rem; margin-top: 1.75rem; }
  time { color: GrayText; }
  code, .version { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<h1>What’s new in ${escapeHtml(release.app)} <span class="version">${escapeHtml(release.version)}</span></h1>
<time datetime="${release.createdAt.toISOString()}">${release.createdAt.toUTCString().replace(/ GMT$/, ' UTC')}</time>
${blocks}
</body>
</html>`;
}
