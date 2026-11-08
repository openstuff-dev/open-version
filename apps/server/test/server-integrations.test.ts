import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Pool } from '../src/db.js';
import { DEMO_DEVELOPER, seedDemo } from '../src/seed-demo.js';

// TEST_DATABASE_URL=postgres://openversion:openversion@localhost:5434/openversion_test
// The database is emptied first. A local server stands in for OpenAnnounce's feed.
const url = process.env.TEST_DATABASE_URL ?? '';
const PUBLIC_URL = 'https://ov.example';
const SIGNING = 'signing-secret-value-123';
const GOOD_KEY = 'pk_good_key_12345';

/** Answers like OpenAnnounce's feed: 401 for an unknown key, 403 for an origin not allowed. */
function feedHandler(allowedOrigin: string): http.RequestListener {
  return (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.headers['x-openannounce-key'] !== GOOD_KEY) {
      send(401, { error: 'That public key doesn’t belong to any system.' });
    } else if (request.headers.origin !== allowedOrigin) {
      send(403, { error: `${String(request.headers.origin)} isn’t one of this system’s allowed origins.` });
    } else {
      send(200, { items: [] });
    }
  };
}

describe.skipIf(!url)('server-wide OpenAnnounce connection', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let feed: http.Server;
  let feedUrl: string;
  let root: string;
  let developer: string;

  const inject = (
    cookie: string | null,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: path,
      payload: payload as object,
      headers: cookie ? { cookie } : {},
    });

  async function signIn(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/session', payload: { email, password } });
    const cookie = response.cookies.find((c) => c.name === 'ov_session');
    if (!cookie) throw new Error(`No session for ${email}`);
    return `ov_session=${cookie.value}`;
  }

  /** Starts a fresh app on the same database. `env` overrides the environment settings. */
  async function open(env: Record<string, string> = {}, publicUrl = PUBLIC_URL) {
    app = await buildApp(
      {
        ...loadConfig(env),
        databaseUrl: url,
        logLevel: 'silent',
        publicUrl,
        fetch: 'private',
        fetchAllow: ['127.0.0.1'],
        secretKey: 'test-secret-key',
        versionRateLimit: 1000,
      },
      pool,
    );
    await app.ready();
  }

  beforeAll(async () => {
    const owner = new pg.Client({ connectionString: url });
    await owner.connect();
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.end();
    await migrate(url, fileURLToPath(new URL('../migrations', import.meta.url)));
    pool = createPool(url);
    await seedDemo(pool);
    await pool.query(
      `INSERT INTO accounts (email, name, password_hash, is_server_admin) VALUES ('root@example.com', 'Root', $1, true)`,
      [await hashPassword('root-password')],
    );
    feed = http.createServer(feedHandler(PUBLIC_URL));
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve));
    feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;
    await open();
    root = await signIn('root@example.com', 'root-password');
    developer = await signIn(DEMO_DEVELOPER.email, DEMO_DEVELOPER.password);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await new Promise<void>((resolve) => {
      feed.close(() => {
        resolve();
      });
    });
  });

  it('refuses people who are not server admins, and anyone signed out', async () => {
    expect((await inject(null, 'GET', '/api/admin/integrations')).statusCode).toBe(401);
    expect((await inject(developer, 'GET', '/api/admin/integrations')).statusCode).toBe(403);
    const put = { url: feedUrl, publicKey: GOOD_KEY };
    expect((await inject(developer, 'PUT', '/api/admin/integrations/openannounce', put)).statusCode).toBe(403);
  });

  it('shows no connection before one is made', async () => {
    const [card] = (await inject(root, 'GET', '/api/admin/integrations')).json<{ status: string; url: unknown }[]>();
    expect(card).toMatchObject({ status: 'not-connected', url: null, source: null });
  });

  it('connects, tests the feed with this server’s origin, and says it worked', async () => {
    const response = await inject(root, 'PUT', '/api/admin/integrations/openannounce', {
      url: feedUrl,
      publicKey: GOOD_KEY,
      signingSecret: SIGNING,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'connected', source: 'database', hasSigningSecret: true });
  });

  it('keeps the connection and says what to fix when the feed refuses the key', async () => {
    const response = await inject(root, 'PUT', '/api/admin/integrations/openannounce', {
      url: feedUrl,
      publicKey: 'pk_wrong_key_99999',
    });
    expect(response.json()).toMatchObject({ status: 'problem', hasSigningSecret: true });
    expect(response.json<{ message: string }>().message).toContain('doesn’t recognise this public key');
  });

  it('names the exact origin to add when OpenAnnounce refuses this server', async () => {
    await app.close();
    await open({}, 'https://other.example');
    const other = await signIn('root@example.com', 'root-password');
    const response = await inject(other, 'POST', '/api/admin/integrations/openannounce/test', {
      url: feedUrl,
      publicKey: GOOD_KEY,
    });
    expect(response.json<{ ok: boolean }>().ok).toBe(false);
    expect(response.json<{ message: string }>().message).toContain('Add https://other.example to allowed origins');
    await app.close();
    await open();
    root = await signIn('root@example.com', 'root-password');
  });

  it('never returns the signing secret, and stores it encrypted', async () => {
    expect((await inject(root, 'GET', '/api/admin/integrations')).body).not.toContain(SIGNING);
    const { rows } = await pool.query<{ signing_secret_encrypted: string }>(
      "SELECT signing_secret_encrypted FROM server_integrations WHERE kind = 'openannounce'",
    );
    expect(rows[0].signing_secret_encrypted).toBeTruthy();
    expect(rows[0].signing_secret_encrypted).not.toContain(SIGNING);
  });

  it('keeps a team export free of the signing secret', async () => {
    const { rows } = await pool.query<{ slug: string }>('SELECT slug FROM teams LIMIT 1');
    const response = await inject(root, 'GET', `/api/t/${rows[0].slug}/export`);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SIGNING);
  });

  it('shows the connection to everyone as public values only, with no sign-in', async () => {
    const response = await inject(null, 'GET', '/api/client-config');
    expect(response.json()).toEqual({ openannounce: { url: feedUrl, publicKey: 'pk_wrong_key_99999' } });
    expect(response.body).not.toContain(SIGNING);
  });

  it('lets the environment win: the card is read-only and saving is refused', async () => {
    await app.close();
    await open({
      OPENVERSION_OPENANNOUNCE_URL: 'https://env-announce.example',
      OPENVERSION_OPENANNOUNCE_PUBLIC_KEY: 'pk_from_env_12345',
    });
    const envRoot = await signIn('root@example.com', 'root-password');
    const [card] = (await inject(envRoot, 'GET', '/api/admin/integrations')).json<
      { status: string; source: string; url: string }[]
    >();
    expect(card).toMatchObject({ status: 'set-by-server', source: 'environment', url: 'https://env-announce.example' });
    const put = { url: feedUrl, publicKey: GOOD_KEY };
    expect((await inject(envRoot, 'PUT', '/api/admin/integrations/openannounce', put)).statusCode).toBe(409);
    expect((await inject(envRoot, 'DELETE', '/api/admin/integrations/openannounce')).statusCode).toBe(409);
    expect((await inject(null, 'GET', '/api/client-config')).json()).toEqual({
      openannounce: { url: 'https://env-announce.example', publicKey: 'pk_from_env_12345' },
    });
    await app.close();
    await open();
    root = await signIn('root@example.com', 'root-password');
  });

  it('disconnects, and the client config goes back to nothing', async () => {
    expect((await inject(root, 'DELETE', '/api/admin/integrations/openannounce')).json()).toEqual({ ok: true });
    expect((await inject(null, 'GET', '/api/client-config')).json()).toEqual({ openannounce: null });
  });
});
