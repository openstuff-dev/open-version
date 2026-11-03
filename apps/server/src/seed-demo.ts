import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';
import { loadConfig } from './config.js';
import { newPublicKey } from './crypto.js';
import { type Client, createPool, migrate, type Pool, withScope } from './db.js';
import { deployTokenColumns } from './model.js';

export const DEMO_ADMIN = { email: 'admin@demo.test', password: 'demo-admin-pass', name: 'Ada Admin' };
export const DEMO_DEVELOPER = { email: 'dev@demo.test', password: 'demo-dev-pass', name: 'Dev Developer' };
export const DEMO_VIEWER = { email: 'viewer@demo.test', password: 'demo-viewer-pass', name: 'Vic Viewer' };

export interface DemoKeys {
  app: string;
  environment: string;
  publicKey: string;
  deployToken: string;
}

interface SeedRelease {
  version: string;
  notes: string;
  hard?: boolean;
  daysAgo: number;
}

const RELEASES: Record<string, SeedRelease[]> = {
  'shop/production': [
    { version: '1.2.0', notes: '- Wish lists\n- Faster search', daysAgo: 30 },
    { version: '1.3.0', notes: '- Pay with gift cards', daysAgo: 12 },
    { version: '1.3.1', notes: '- Fixed the basket total when a code is removed', hard: true, daysAgo: 9 },
    { version: '1.4.0', notes: '## New\n\n- Order tracking in the account page\n- Dark mode', daysAgo: 2 },
  ],
  'shop/staging': [
    { version: '1.4.0', notes: '- Order tracking\n- Dark mode', daysAgo: 4 },
    { version: '1.5.0-rc.1', notes: '- Returns from the account page', daysAgo: 1 },
  ],
  'back-office/production': [
    { version: '0.9.0', notes: 'First version for the warehouse team.', daysAgo: 20 },
    { version: '0.9.1', notes: '- Printing labels works on Safari', daysAgo: 6 },
  ],
};

async function addEnvironment(
  db: Client,
  teamId: string,
  appId: string,
  key: string,
  name: string,
  origin: string,
): Promise<DemoKeys> {
  const token = deployTokenColumns(name);
  const publicKey = newPublicKey();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO environments (team_id, app_id, name, public_key, deploy_token_hash, deploy_token_prefix,
       deploy_token_last4, allowed_origins)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [teamId, appId, name, publicKey, token.hash, token.prefix, token.last4, [origin, 'http://localhost:8080', 'http://localhost:4200']],
  );
  const envId = rows[0].id;
  let live: string | null = null;
  for (const r of RELEASES[`${key}/${name}`] ?? []) {
    const result = await db.query<{ id: string }>(
      `INSERT INTO releases (team_id, environment_id, version, notes, hard, source, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, 'cli', 'Deploy token', now() - make_interval(days => $6)) RETURNING id`,
      [teamId, envId, r.version, r.notes, r.hard ?? false, r.daysAgo],
    );
    live = result.rows[0].id;
  }
  await db.query('UPDATE environments SET live_release_id = $2 WHERE id = $1', [envId, live]);
  return { app: key, environment: name, publicKey, deployToken: token.token };
}

/**
 * A demo team: Shop (production and staging) and Back office (production), a few releases
 * each, some recent version checks, and a member per role. Run it again to start over.
 */
export async function seedDemo(pool: Pool): Promise<DemoKeys[]> {
  const accounts: { email: string; password: string; name: string; role: string }[] = [
    { ...DEMO_ADMIN, role: 'admin' },
    { ...DEMO_DEVELOPER, role: 'developer' },
    { ...DEMO_VIEWER, role: 'viewer' },
  ];
  return withScope(pool, { bypass: true }, async (db) => {
    await db.query(`DELETE FROM teams WHERE slug = 'demo'`);
    const { rows } = await db.query<{ id: string }>(`INSERT INTO teams (slug, name) VALUES ('demo', 'Demo team') RETURNING id`);
    const teamId = rows[0].id;
    for (const a of accounts) {
      const { rows: acc } = await db.query<{ id: string }>(
        `INSERT INTO accounts (email, name, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [a.email, a.name, await hashPassword(a.password)],
      );
      await db.query('INSERT INTO members (team_id, account_id, role) VALUES ($1, $2, $3)', [teamId, acc[0].id, a.role]);
    }
    const keys: DemoKeys[] = [];
    const apps = [
      { slug: 'shop', name: 'Shop', baseUrl: 'https://shop.example.com', environments: ['production', 'staging'] },
      { slug: 'back-office', name: 'Back office', baseUrl: 'https://office.example.com', environments: ['production'] },
    ];
    for (const a of apps) {
      const { rows: created } = await db.query<{ id: string }>(
        'INSERT INTO apps (team_id, slug, name, base_url) VALUES ($1, $2, $3, $4) RETURNING id',
        [teamId, a.slug, a.name, a.baseUrl],
      );
      for (const env of a.environments) {
        const origin = new URL(a.baseUrl).origin;
        keys.push(await addEnvironment(db, teamId, created[0].id, a.slug, env, origin));
      }
    }
    // About 40 open Shop tabs and a few on staging, so the live dots have something to show.
    await db.query(
      `INSERT INTO client_pings (team_id, environment_id, minute, count)
       SELECT $1, e.id, date_trunc('minute', now()) - make_interval(mins => m),
              CASE WHEN e.name = 'production' AND a.slug = 'shop' THEN 8 ELSE 1 END
         FROM environments e JOIN apps a ON a.id = e.app_id, generate_series(0, 4) AS m
        WHERE e.team_id = $1 AND NOT (a.slug = 'back-office')`,
      [teamId],
    );
    return keys;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  await migrate(config.databaseUrl, fileURLToPath(new URL('../migrations', import.meta.url)));
  const pool = createPool(config.databaseUrl);
  const keys = await seedDemo(pool);
  await pool.end();
  const lines = [
    'Seeded the demo team. Sign in at ' + config.publicUrl + ' as:',
    ...(
      [
        [DEMO_ADMIN, 'admin'],
        [DEMO_DEVELOPER, 'developer'],
        [DEMO_VIEWER, 'viewer'],
      ] as const
    ).map(([account, role]) => `  ${role.padEnd(10)} ${account.email} / ${account.password}`),
    '',
    'Keys (deploy tokens are shown this once; regenerate them on the Keys tab):',
    ...keys.map((k) => `  ${`${k.app}/${k.environment}`.padEnd(24)} ${k.publicKey}  ${k.deployToken}`),
    '',
    'Try the CLI against Shop production:',
    `  OPENVERSION_URL=${config.publicUrl} OPENVERSION_TOKEN=${keys[0].deployToken} npx openversion release --minor`,
  ];
  console.log(lines.join('\n'));
}
