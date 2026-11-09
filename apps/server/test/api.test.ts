import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AppSummary,
  Environment,
  Me,
  NewApp,
  PublishedRelease,
  Release,
  TeamExport,
  VersionInfo,
} from '@open-version/contracts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { vaultFor } from '@openstuff-dev/server';
import { postToOpenAnnounce } from '../src/openannounce.js';
import { MAX_ATTEMPTS, sendOutbox } from '../src/worker.js';
import { createPool, migrate, type Pool, withScope } from '../src/db.js';
import {
  DEMO_ADMIN,
  DEMO_DEVELOPER,
  DEMO_VIEWER,
  type DemoKeys,
  seedDemo,
} from '../src/seed-demo.js';

// These tests need Postgres:
// TEST_DATABASE_URL=postgres://openversion:openversion@localhost:5434/openversion_test
// The database is emptied first.
const url = process.env.TEST_DATABASE_URL ?? '';
const vault = vaultFor('test-secret-key');

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected a ${what}.`);
  return value;
}

describe.skipIf(!url)('API against Postgres', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let root: string;
  let admin: string;
  let developer: string;
  let viewer: string;
  let keys: DemoKeys[];
  let shop: DemoKeys;
  let staging: DemoKeys;

  const inject = (
    cookie: string | null,
    method: string,
    path: string,
    payload?: unknown,
    headers = {},
  ) =>
    app.inject({
      method: method as 'GET',
      url: path,
      payload: payload as object,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    });
  const ci = (token: string, method: string, path: string, payload?: unknown, headers = {}) =>
    inject(null, method, path, payload, { authorization: `Bearer ${token}`, ...headers });
  const version = (key: string, headers: Record<string, string> = {}) =>
    inject(null, 'GET', `/api/v1/version?key=${key}`, undefined, headers);

  async function signIn(email: string, password: string): Promise<string> {
    const response = await inject(null, 'POST', '/api/session', { email, password });
    expect(response.statusCode).toBe(200);
    const cookie = must(response.cookies.find((c) => c.name === 'ov_session'), 'session cookie');
    return `ov_session=${cookie.value}`;
  }

  async function environment(cookie: string, appSlug: string, env: string): Promise<Environment> {
    const response = await inject(cookie, 'GET', `/api/t/demo/apps/${appSlug}/environments/${env}`);
    expect(response.statusCode).toBe(200);
    return response.json<Environment>();
  }

  beforeAll(async () => {
    const owner = new pg.Client({ connectionString: url });
    await owner.connect();
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.end();
    await migrate(url, fileURLToPath(new URL('../migrations', import.meta.url)));
    pool = createPool(url);
    app = await buildApp({ ...loadConfig({}), databaseUrl: url, logLevel: 'silent', versionRateLimit: 1000 }, pool, {
      vault: () => Promise.resolve(vault),
      testConnection: (target, key) =>
        key === 'ak_good_key'
          ? Promise.resolve('Connected.')
          : Promise.reject(new Error(`${target} refused the key.`)),
    });
    await pool.query(
      `INSERT INTO accounts (email, name, password_hash, is_server_admin) VALUES ('root@example.com', 'Root', $1, true)`,
      [await hashPassword('root-password')],
    );
    keys = await seedDemo(pool);
    shop = must(keys.find((k) => k.app === 'shop' && k.environment === 'production'), 'shop key');
    staging = must(keys.find((k) => k.app === 'shop' && k.environment === 'staging'), 'staging key');
    root = await signIn('root@example.com', 'root-password');
    admin = await signIn(DEMO_ADMIN.email, DEMO_ADMIN.password);
    developer = await signIn(DEMO_DEVELOPER.email, DEMO_DEVELOPER.password);
    viewer = await signIn(DEMO_VIEWER.email, DEMO_VIEWER.password);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('sign-in and roles', () => {
    it('lists the teams of the signed-in person with their role', async () => {
      expect((await inject(null, 'GET', '/api/me')).statusCode).toBe(401);
      const me = (await inject(viewer, 'GET', '/api/me')).json<Me>();
      expect(me.teams).toEqual([{ slug: 'demo', name: 'Demo team', role: 'viewer' }]);
    });

    it('lets a viewer read but not hard refresh, publish or change keys', async () => {
      expect((await inject(viewer, 'GET', '/api/t/demo/apps')).statusCode).toBe(200);
      const env = await environment(viewer, 'shop', 'production');
      expect((await inject(viewer, 'POST', `/api/t/demo/environments/${env.id}/refresh`)).statusCode).toBe(403);
      expect((await inject(viewer, 'POST', `/api/t/demo/environments/${env.id}/releases`, { bump: 'patch' })).statusCode).toBe(403);
      expect((await inject(viewer, 'POST', `/api/t/demo/environments/${env.id}/token`)).statusCode).toBe(403);
    });

    it('refuses changes posted from another origin', async () => {
      const response = await inject(admin, 'POST', '/api/t/demo/apps', { name: 'X', baseUrl: 'https://x.test' }, { origin: 'https://evil.test' });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('deploy tokens', () => {
    it('can never manage members, teams or tokens, not even their own environment', async () => {
      const env = await environment(admin, 'shop', 'production');
      const attempts = [
        ['GET', '/api/t/demo/members'],
        ['POST', '/api/t/demo/members', { email: 'new@demo.test', role: 'admin' }],
        ['POST', `/api/t/demo/environments/${env.id}/token`],
        ['POST', '/api/teams', { name: 'Mine' }],
        ['GET', '/api/me'],
      ] as const;
      for (const [method, path, body] of attempts) {
        const response = await ci(shop.deployToken, method, path, body);
        expect(response.statusCode, `${method} ${path}`).toBe(403);
      }
      // Not even with a member's cookie next to it.
      const both = await inject(admin, 'GET', '/api/t/demo/members', undefined, { authorization: `Bearer ${shop.deployToken}` });
      expect(both.statusCode).toBe(403);
    });

    it('refuses an unknown token', async () => {
      expect((await ci('ov_live_0000000000000000000000000000', 'GET', '/api/v1/releases/live')).statusCode).toBe(401);
      expect((await inject(null, 'POST', '/api/v1/refresh')).statusCode).toBe(401);
    });
  });

  describe('publishing', () => {
    it('reads the live release', async () => {
      const live = (await ci(shop.deployToken, 'GET', '/api/v1/releases/live')).json<PublishedRelease>();
      expect(live).toMatchObject({ version: '1.4.0', app: 'Shop', environment: 'production' });
    });

    it('refuses a version that is not higher than the live one, naming the live one', async () => {
      const lower = await ci(shop.deployToken, 'POST', '/api/v1/releases', { version: '1.3.9' });
      expect(lower.statusCode).toBe(409);
      expect(lower.json<{ error: string }>().error).toContain('1.4.0 is live');
      expect((await ci(shop.deployToken, 'POST', '/api/v1/releases', { version: '1.4.0' })).statusCode).toBe(409);
      expect((await ci(shop.deployToken, 'POST', '/api/v1/releases', { version: 'latest' })).statusCode).toBe(400);
    });

    it('publishes once per Idempotency-Key, however often CI retries', async () => {
      const send = () =>
        ci(shop.deployToken, 'POST', '/api/v1/releases', { bump: 'minor', notes: '- Gift wrap' }, { 'idempotency-key': 'sha-abc123', 'user-agent': 'openversion-cli/0.1' });
      const first = await send();
      expect(first.statusCode).toBe(201);
      expect(first.json<PublishedRelease>().version).toBe('1.5.0');
      const again = await send();
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json<PublishedRelease>().id).toBe(first.json<PublishedRelease>().id);
      const env = await environment(admin, 'shop', 'production');
      const history = (await inject(admin, 'GET', `/api/t/demo/environments/${env.id}/releases`)).json<Release[]>();
      expect(history.filter((r) => r.version === '1.5.0')).toHaveLength(1);
      expect(history[0]).toMatchObject({ version: '1.5.0', source: 'cli', createdBy: 'Deploy token' });
      // The same key with another body is a mistake, not a retry.
      const other = await ci(shop.deployToken, 'POST', '/api/v1/releases', { bump: 'major' }, { 'idempotency-key': 'sha-abc123' });
      expect(other.statusCode).toBe(422);
    });

    it('raises the epoch on a hard refresh', async () => {
      const before = await environment(developer, 'shop', 'production');
      const response = await inject(developer, 'POST', `/api/t/demo/environments/${before.id}/refresh`);
      expect(response.json<Environment>().refreshEpoch).toBe(before.refreshEpoch + 1);
      const viaCi = await ci(shop.deployToken, 'POST', '/api/v1/refresh');
      expect(viaCi.json<{ epoch: number }>().epoch).toBe(before.refreshEpoch + 2);
    });

    it('rolls back: an older release is live again, recorded as a hard release', async () => {
      const env = await environment(developer, 'shop', 'production');
      const history = (await inject(developer, 'GET', `/api/t/demo/environments/${env.id}/releases`)).json<Release[]>();
      const older = must(history.find((r) => r.version === '1.4.0'), '1.4.0');
      const response = await inject(developer, 'POST', `/api/t/demo/releases/${older.id}/live`);
      expect(response.statusCode).toBe(200);
      const live = must(response.json<Environment>().live, 'live release');
      expect(live).toMatchObject({ version: '1.4.0', hard: true, rollbackOf: older.id });
      expect((await inject(developer, 'POST', `/api/t/demo/releases/${older.id}/live`)).statusCode).toBe(409);
      // 1.5.0 was published before, so CI must go higher.
      const again = await ci(shop.deployToken, 'POST', '/api/v1/releases', { version: '1.5.0' });
      expect(again.statusCode).toBe(409);
      expect(again.json<{ error: string }>().error).toContain('already published');
      expect((await ci(shop.deployToken, 'POST', '/api/v1/releases', { version: '1.5.1' })).statusCode).toBe(201);
    });

    it('shows a regenerated token once, and the old one stops working', async () => {
      const env = await environment(admin, 'shop', 'staging');
      const response = await inject(admin, 'POST', `/api/t/demo/environments/${env.id}/token`);
      const created = response.json<{ deployToken: string; tokenHint: string }>();
      const { deployToken, tokenHint } = created;
      expect(deployToken).toMatch(/^ov_test_/);
      expect(tokenHint).toBe(`ov_test_••••${deployToken.slice(-4)}`);
      expect((await ci(staging.deployToken, 'GET', '/api/v1/releases/live')).statusCode).toBe(401);
      expect((await ci(deployToken, 'GET', '/api/v1/releases/live')).statusCode).toBe(200);
      const read = await environment(admin, 'shop', 'staging');
      expect(JSON.stringify(read)).not.toContain(deployToken);
      staging = { ...staging, deployToken };
    });
  });

  describe('the version endpoint', () => {
    it('answers the live version, then 304 for the same ETag', async () => {
      const first = await version(staging.publicKey, { origin: 'https://shop.example.com' });
      expect(first.statusCode).toBe(200);
      expect(first.headers['access-control-allow-origin']).toBe('https://shop.example.com');
      expect(first.headers['cache-control']).toBe('no-cache');
      const info = first.json<VersionInfo>();
      expect(info).toMatchObject({ version: '1.5.0-rc.1', hard: false, policy: 'prompt' });
      expect(info.notesUrl).toMatch(/\/notes\/[0-9a-f-]{36}$/);
      const etag = must(first.headers.etag, 'etag');
      const second = await version(staging.publicKey, { origin: 'https://shop.example.com', 'if-none-match': etag });
      expect(second.statusCode).toBe(304);
    });

    it('refuses an unknown origin and an unknown key', async () => {
      const evil = await version(staging.publicKey, { origin: 'https://evil.test' });
      expect(evil.statusCode).toBe(403);
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
      expect((await version('pk_doesnotexist0000')).statusCode).toBe(401);
      expect((await inject(null, 'GET', '/api/v1/version')).statusCode).toBe(400);
    });

    it('makes one database round trip', async () => {
      await version(staging.publicKey); // warm the connection (it drops privileges once)
      const spy = vi.spyOn(pg.Client.prototype, 'query');
      try {
        const response = await version(staging.publicKey, { origin: 'https://shop.example.com' });
        expect(response.statusCode).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('counts checks for the live dot', async () => {
      const apps = (await inject(viewer, 'GET', '/api/t/demo/apps')).json<AppSummary[]>();
      const shopApp = must(apps.find((a) => a.slug === 'shop'), 'shop');
      const env = must(shopApp.environments.find((e) => e.name === 'staging'), 'staging');
      expect(env.recentChecks).toBeGreaterThan(5);
      expect(shopApp.environments.map((e) => e.name)).toEqual(['production', 'staging']);
    });

    it('rate-limits checks per key and address', async () => {
      const limited = await buildApp({ ...loadConfig({}), databaseUrl: url, logLevel: 'silent', versionRateLimit: 2 }, pool);
      try {
        const call = () => limited.inject({ url: `/api/v1/version?key=${staging.publicKey}` });
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(200);
        const third = await call();
        expect(third.statusCode).toBe(429);
        expect(third.headers['retry-after']).toBeDefined();
      } finally {
        await limited.close();
      }
    });

    it('has no limit when it is set to 0', async () => {
      const unlimited = await buildApp(
        { ...loadConfig({}), databaseUrl: url, logLevel: 'silent', versionRateLimit: 0 },
        pool,
      );
      try {
        for (let i = 0; i < 5; i++) {
          const response = await unlimited.inject({ url: `/api/v1/version?key=${staging.publicKey}` });
          expect(response.statusCode).toBe(200);
        }
      } finally {
        await unlimited.close();
      }
    });

    it('serves the notes page with the notes escaped', async () => {
      const info = (await version(staging.publicKey)).json<VersionInfo>();
      const page = await inject(null, 'GET', new URL(must(info.notesUrl)).pathname);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Returns from the account page');
    });

    it('serves the browser package at /sdk/, but not the CLI', async () => {
      const element = await inject(null, 'GET', '/sdk/update/index.js');
      expect(element.statusCode).toBe(200);
      expect(element.headers['access-control-allow-origin']).toBe('*');
      expect(element.body).toContain('ov-update');
      expect((await inject(null, 'GET', '/sdk/cli/index.js')).statusCode).toBe(404);
    });

    it('serves the demo page only with OPENVERSION_DEMO=on, as the live version', async () => {
      expect((await inject(null, 'GET', '/demo')).statusCode).toBe(404);
      const demo = await buildApp({ ...loadConfig({ OPENVERSION_DEMO: 'on' }), databaseUrl: url, logLevel: 'silent' }, pool);
      try {
        const page = await demo.inject({ url: '/demo?app=shop&env=staging' });
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('"version":"1.5.0-rc.1"');
        expect(page.body).toContain(staging.publicKey);
        expect((await demo.inject({ url: '/demo?app=nope' })).statusCode).toBe(404);
      } finally {
        await demo.close();
      }
    });

    it('documents /api/v1 in OpenAPI', async () => {
      const doc = (await inject(null, 'GET', '/api/v1/openapi.json')).json<{ paths: Record<string, unknown> }>();
      expect(Object.keys(doc.paths).sort()).toEqual(['/api/v1/refresh', '/api/v1/releases', '/api/v1/releases/live', '/api/v1/version']);
    });
  });

  describe('apps and teams', () => {
    it('creates an app with environments and shows each deploy token once', async () => {
      const response = await inject(developer, 'POST', '/api/t/demo/apps', {
        name: 'Help Centre',
        baseUrl: 'https://help.example.com/',
        environments: ['production', 'staging'],
      });
      expect(response.statusCode).toBe(201);
      const created = response.json<NewApp>();
      expect(created.app).toMatchObject({ slug: 'help-centre', baseUrl: 'https://help.example.com' });
      expect(created.environments.map((e) => e.deployToken.slice(0, 8))).toEqual(['ov_live_', 'ov_test_']);
      expect(created.environments[0].allowedOrigins).toEqual(['https://help.example.com']);
      expect(created.environments[0].live).toBeNull();
    });

    it('keeps teams apart, in the API and in the database', async () => {
      const other = await inject(root, 'POST', '/api/teams', { name: 'Other team' });
      expect(other.statusCode).toBe(201);
      const otherId = other.json<{ id: string }>().id;
      await inject(root, 'POST', '/api/t/other-team/apps', { name: 'Secret', baseUrl: 'https://secret.test' });
      expect((await inject(admin, 'GET', '/api/t/other-team/apps')).statusCode).toBe(404);
      const demoApps = (await inject(admin, 'GET', '/api/t/demo/apps')).json<AppSummary[]>();
      expect(demoApps.map((a) => a.name)).not.toContain('Secret');
      // Even a query without a WHERE clause sees only its own team.
      const { rows: demoTeam } = await pool.query<{ id: string }>(`SELECT id FROM teams WHERE slug = 'demo'`);
      const seen = await withScope(pool, { teamId: demoTeam[0].id }, (db) =>
        db.query<{ name: string }>('SELECT a.name FROM apps a JOIN environments e ON e.app_id = a.id'),
      );
      expect(seen.rows.map((r) => r.name)).not.toContain('Secret');
      const fromOther = await withScope(pool, { teamId: otherId }, (db) => db.query('SELECT 1 FROM releases'));
      expect(fromOther.rowCount).toBe(0);
    });

    it('nobody changes their own role', async () => {
      const me = (await inject(admin, 'GET', '/api/me')).json<Me>();
      const response = await inject(admin, 'PATCH', `/api/t/demo/members/${me.id}`, { role: 'viewer' });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('integrations', () => {
    it('UC-5/S7 adds release notes for a picked environment, admins only, and lists it for the team', async () => {
      const env = await environment(admin, 'shop', 'production');
      const body = { url: 'https://announce.example.com', publishKey: 'ak_good_key' };
      expect((await inject(developer, 'POST', `/api/t/demo/environments/${env.id}/integrations`, body)).statusCode).toBe(403);
      const created = await inject(admin, 'POST', `/api/t/demo/environments/${env.id}/integrations`, {
        url: 'https://announce.example.com',
        publishKey: 'ak_good_key',
        groups: ['shop', 'shop'],
      });
      expect(created.statusCode).toBe(201);
      expect(created.body).not.toContain('ak_good_key');
      const integration = created.json<{ id: string; hasKey: boolean; groups: string[] }>();
      expect(integration).toMatchObject({ hasKey: true, groups: ['shop'] });
      const { rows } = await withScope(pool, { bypass: true }, (db) =>
        db.query<{ sealed: string }>('SELECT publish_key_encrypted AS sealed FROM integrations WHERE id = $1', [integration.id]),
      );
      expect(rows[0].sealed).not.toContain('ak_good_key');
      expect((await inject(admin, 'POST', `/api/t/demo/integrations/${integration.id}/test`)).statusCode).toBe(200);
      const wrong = await inject(admin, 'POST', `/api/t/demo/integrations/${integration.id}/test`, { publishKey: 'ak_wrong_key' });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json<{ error: string }>().error).toContain('refused the key');
      expect((await inject(developer, 'POST', `/api/t/demo/integrations/${integration.id}/test`)).statusCode).toBe(403);
      const list = (await inject(developer, 'GET', '/api/t/demo/integrations')).json<{ id: string; environmentName: string }[]>();
      expect(list).toContainEqual(expect.objectContaining({ id: integration.id, environmentName: 'production' }));
    });

    it('UC-5/S7 queues the notes of every new release in the same transaction', async () => {
      const published = await ci(shop.deployToken, 'POST', '/api/v1/releases', { bump: 'patch', notes: 'Fixes' });
      expect(published.statusCode).toBe(201);
      const env = await environment(admin, 'shop', 'production');
      expect(must(env.live).deliveries).toMatchObject([{ kind: 'open-announce', status: 'pending', attempts: 0 }]);
    });
  });

  describe('posting release notes to OpenAnnounce', () => {
    // A fake OpenAnnounce: it posts once per Idempotency-Key, like the real one.
    const posts = new Map<string, { title: string; body: string; groups?: string[] }>();
    let requests = 0;
    let answer = 201;
    let fake: http.Server;
    let fakeUrl = '';
    const PRIVATE = { mode: 'private', allow: [] } as const;
    type Post = Parameters<typeof postToOpenAnnounce>[3];
    const poster = (target: string, key: string, release: Post) =>
      postToOpenAnnounce(PRIVATE, target, key, release);
    let backOffice: DemoKeys;

    beforeAll(async () => {
      fake = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('end', () => {
          requests++;
          if (req.headers.authorization !== 'Bearer ak_fake_publish_key_123') {
            res.writeHead(401).end(JSON.stringify({ error: 'That publish key isn’t valid.' }));
            return;
          }
          if (answer !== 201) {
            res.writeHead(answer).end(JSON.stringify({ error: `Fake error ${answer}` }));
            return;
          }
          const key = String(req.headers['idempotency-key']);
          const replay = posts.has(key);
          if (!replay) posts.set(key, JSON.parse(raw) as { title: string; body: string });
          res.writeHead(replay ? 200 : 201, { 'content-type': 'application/json' }).end('{}');
        });
      });
      await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
      fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
      backOffice = must(keys.find((k) => k.app === 'back-office'), 'back office');
      const env = await environment(admin, 'back-office', 'production');
      const created = await inject(admin, 'POST', `/api/t/demo/environments/${env.id}/integrations`, {
        url: fakeUrl,
        publishKey: 'ak_fake_publish_key_123',
        groups: ['warehouse'],
      });
      expect(created.statusCode).toBe(201);
    });

    afterAll(() => {
      fake.close();
    });

    const deliveries = async () => {
      const env = await environment(admin, 'back-office', 'production');
      const history = (await inject(admin, 'GET', `/api/t/demo/environments/${env.id}/releases`)).json<Release[]>();
      return history[0];
    };

    it('posts "{App} {version}" with the notes once, even when the post is retried', async () => {
      const published = await ci(backOffice.deployToken, 'POST', '/api/v1/releases', { version: '1.0.0', notes: '- Barcode scanning' });
      expect(published.statusCode).toBe(201);
      expect(await sendOutbox(pool, vault, poster)).toBe(1);
      expect([...posts.values()]).toEqual([{ title: 'Back office 1.0.0', body: '- Barcode scanning', groups: ['warehouse'] }]);
      expect((await deliveries()).deliveries).toMatchObject([{ status: 'sent', attempts: 1, lastError: null }]);
      // Nothing left to send; a forced resend (the worker died after posting) reuses the key.
      expect(await sendOutbox(pool, vault, poster)).toBe(0);
      await withScope(pool, { bypass: true }, (db) => db.query(`UPDATE outbox SET status = 'pending', next_attempt_at = now()`));
      await sendOutbox(pool, vault, poster);
      expect(posts.size).toBe(1);
    });

    it('backs off on server errors and gives up after the last try, with the reason', async () => {
      answer = 503;
      await ci(backOffice.deployToken, 'POST', '/api/v1/releases', { version: '1.1.0', notes: 'Faster' });
      const before = requests;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await withScope(pool, { bypass: true }, (db) =>
          db.query(`UPDATE outbox SET next_attempt_at = now() WHERE status = 'pending'`),
        );
        await sendOutbox(pool, vault, poster);
        const latest = must((await deliveries()).deliveries[0]);
        expect(latest.attempts).toBe(i + 1);
        expect(latest.status).toBe(i + 1 < MAX_ATTEMPTS ? 'pending' : 'failed');
      }
      expect(requests - before).toBe(MAX_ATTEMPTS);
      expect((await deliveries()).deliveries[0].lastError).toContain('Fake error 503');
    });

    it('stops at once when the key is refused, and Retry starts over', async () => {
      answer = 201;
      const env = await environment(admin, 'back-office', 'production');
      const [integration] = (await inject(admin, 'GET', `/api/t/demo/environments/${env.id}/integrations`)).json<{ id: string }[]>();
      await inject(admin, 'PATCH', `/api/t/demo/integrations/${integration.id}`, { publishKey: 'ak_wrong_key_0000000' });
      await ci(backOffice.deployToken, 'POST', '/api/v1/releases', { version: '1.2.0', notes: 'X' });
      await sendOutbox(pool, vault, poster);
      const refused = await deliveries();
      expect(refused.deliveries[0]).toMatchObject({ status: 'failed', attempts: 1 });
      expect(refused.deliveries[0].lastError).toContain('refused the publish key');
      await inject(admin, 'PATCH', `/api/t/demo/integrations/${integration.id}`, { publishKey: 'ak_fake_publish_key_123' });
      const retry = await inject(developer, 'POST', `/api/t/demo/releases/${refused.id}/deliveries/${integration.id}/retry`);
      expect(retry.statusCode).toBe(200);
      await sendOutbox(pool, vault, poster);
      expect((await deliveries()).deliveries[0]).toMatchObject({ status: 'sent' });
      expect([...posts.values()].map((p) => p.title)).toContain('Back office 1.2.0');
    });
  });

  describe('export and import', () => {
    it('exports without keys, and imports into another team', async () => {
      const exported = await inject(admin, 'GET', '/api/t/demo/export');
      expect(exported.statusCode).toBe(200);
      const file = exported.json<TeamExport>();
      expect(file.note).toContain('not in this file');
      for (const k of keys) {
        expect(exported.body).not.toContain(k.publicKey);
        expect(exported.body).not.toContain(k.deployToken);
      }
      expect(exported.body).not.toContain('ak_good_key');
      const shopExport = must(file.apps.find((a) => a.slug === 'shop'));
      const live = shopExport.environments.find((e) => e.name === 'production')?.releases.filter((r) => r.live);
      expect(live?.map((r) => r.version)).toEqual(['1.5.2']);

      await inject(root, 'POST', '/api/teams', { name: 'Copy' });
      const imported = await inject(root, 'POST', '/api/t/copy/import', file);
      expect(imported.statusCode).toBe(200);
      const copy = (await inject(root, 'GET', '/api/t/copy/apps')).json<AppSummary[]>();
      const shopCopy = must(copy.find((a) => a.slug === 'shop'));
      expect(shopCopy.environments.find((e) => e.name === 'production')?.liveVersion).toBe('1.5.2');
      // Importing again adds nothing twice.
      const again = await inject(root, 'POST', '/api/t/copy/import', file);
      expect(again.json<{ releases: number }>().releases).toBe(0);
    });
  });
});
