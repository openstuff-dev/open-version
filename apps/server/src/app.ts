import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth.js';
import type { Config } from './config.js';
import { loadVault, type Vault } from './crypto.js';
import type { Pool } from './db.js';
import { registerErrorHandler } from './errors.js';
import { registerIdempotency } from './idempotency.js';
import { registerAppRoutes } from './routes/apps.js';
import { registerDemo } from './routes/demo.js';
import { registerIntegrationRoutes, type TestConnection } from './routes/integrations.js';
import { registerReleaseRoutes } from './routes/releases.js';
import { registerTeamRoutes } from './routes/teams.js';
import { registerTransferRoutes } from './routes/transfer.js';
import { registerV1Routes } from './routes/v1.js';

export interface AppOptions {
  /** Checks an OpenAnnounce URL and publish key. Tests pass a fake. */
  testConnection?: TestConnection;
}

export async function buildApp(
  config: Config,
  pool: Pool,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });
  registerErrorHandler(app);
  await app.register(fastifyCookie);
  // Documents /api/v1 (the version endpoint and the CI API) at /api/v1/openapi.json.
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'OpenVersion API',
        version: '1',
        description: 'The version endpoint open tabs call, and the API CI uses to publish releases.',
      },
      servers: [{ url: config.publicUrl }],
      components: {
        securitySchemes: {
          deployToken: { type: 'http', scheme: 'bearer', description: 'The environment’s deploy token, ov_live_… or ov_test_…' },
        },
      },
    },
    hideUntagged: false,
    transform: ({ schema, url }) => ({ schema: url.startsWith('/api/v1/') ? schema : { ...schema, hide: true }, url }),
  });

  app.get('/api/health', { schema: { hide: true } }, async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, () => app.swagger());

  // The vault reads the database on first use, so building the app needs no query.
  let vault: Promise<Vault> | undefined;
  const getVault = () => (vault ??= loadVault(pool, config, app.log));

  registerAuth(app, pool, config);
  registerIdempotency(app, pool);
  registerTeamRoutes(app, pool);
  registerAppRoutes(app, pool);
  registerReleaseRoutes(app, pool);
  registerIntegrationRoutes(
    app,
    pool,
    getVault,
    options.testConnection ??
    (() => Promise.reject(new Error('Testing the connection isn’t available yet.'))),
  );
  registerTransferRoutes(app, pool);
  registerV1Routes(app, pool, config);
  // The built @openstuff-dev/version, so an app can load it from here instead of npm:
  // an import map points "@openstuff-dev/version" at /sdk/core/index.js.
  await app.register(fastifyStatic, {
    root: sdkDir(),
    prefix: '/sdk/',
    decorateReply: false,
    // Short, so a new server version reaches apps soon; the ETag makes rechecks cheap.
    maxAge: '5m',
    allowedPath: (pathName) =>
      !pathName.includes('/cli/') && (pathName.endsWith('.js') || pathName.endsWith('.js.map')),
    setHeaders: (reply) => {
      void reply.header('Access-Control-Allow-Origin', '*');
    },
  });

  if (config.demo) registerDemo(app, pool, config);

  if (config.webDir) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    // The web app routes in the browser, so any other page gets index.html. A missing file
    // (an old build's chunk) is a 404, never index.html, so a stale tab sees a chunk error.
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/') || /\.\w+$/.test(request.url.split('?')[0])
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html'),
    );
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not found' }));
  }

  return app;
}

/** The dist folder of the installed @openstuff-dev/version. */
function sdkDir(): string {
  const entry = fileURLToPath(import.meta.resolve('@openstuff-dev/version'));
  return path.resolve(path.dirname(entry), '..');
}
