import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { type Pool, withScope } from '../db.js';

const query = z.object({
  team: z.string().regex(/^[a-z0-9-]{1,63}$/).default('demo'),
  app: z.string().regex(/^[a-z0-9-]{1,63}$/).default('shop'),
  env: z.string().regex(/^[a-z0-9-]{1,40}$/).default('production'),
});

interface DemoEnv {
  appName: string;
  envName: string;
  publicKey: string;
  live: string | null;
}

/**
 * /demo: a pretend web app that runs @openstuff-dev/version from /sdk/. The page "was built as"
 * the version that was live when it loaded, like a real deploy. Publish a release, press Hard
 * refresh or make an older release live in the dashboard, and watch this tab react.
 */
export function registerDemo(app: FastifyInstance, pool: Pool, config: Config): void {
  app.get('/demo', async (request, reply) => {
    const q = query.parse(request.query);
    const env = await withScope(pool, { bypass: true }, async (db) => {
      const { rows } = await db.query<DemoEnv>(
        `SELECT a.name AS "appName", e.name AS "envName", e.public_key AS "publicKey", r.version AS live
           FROM environments e JOIN apps a ON a.id = e.app_id JOIN teams t ON t.id = e.team_id
           LEFT JOIN releases r ON r.id = e.live_release_id
          WHERE t.slug = $1 AND a.slug = $2 AND e.name = $3`,
        [q.team, q.app, q.env],
      );
      return rows.at(0);
    });
    if (!env) {
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('No such environment. Run `npm run seed:demo -w apps/server` first, or pass ?team=&app=&env=.');
    }
    const dashboard = `${config.publicUrl}/t/${q.team}/apps/${q.app}/${q.env}`;
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(page(config.publicUrl, env, dashboard));
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(url: string, env: DemoEnv, dashboard: string): string {
  // The "build" is whatever was live at load; before any release it is 0.0.0.
  const version = env.live ?? '0.0.0';
  const config = JSON.stringify({
    url,
    publicKey: env.publicKey,
    version,
    interval: 10,
    countdown: 10,
  });
  const title = `${esc(env.appName)} ${esc(version)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title} · OpenVersion demo</title>
  <script type="importmap">{ "imports": {
    "@openstuff-dev/version": "/sdk/core/index.js",
    "@openstuff-dev/version/update": "/sdk/update/index.js"
  } }</script>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.55; }
    body { margin: 0; background: light-dark(#f6f6f7, #111113); color: light-dark(#1c1c1f, #ededef); }
    header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 12px 20px;
      background: light-dark(#fff, #1c1c1f); border-bottom: 1px solid light-dark(#e4e4e7, #34343a); }
    header strong { margin-inline-end: auto; }
    main { max-width: 720px; margin: 32px auto; padding: 0 20px; }
    h1 { text-wrap: balance; }
    p, li { text-wrap: pretty; }
    code, .mono { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; }
    .state { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; padding: 16px;
      border: 1px solid light-dark(#e4e4e7, #34343a); border-radius: 8px; background: light-dark(#fff, #1c1c1f); }
    dt { color: light-dark(#5f5f66, #a1a1aa); }
    dd { margin: 0; }
    a { color: light-dark(#c2255c, #f06595); }
    input { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid light-dark(#d4d4d8, #3f3f46);
      background: light-dark(#fff, #27272a); color: inherit; inline-size: min(100%, 24rem); }
  </style>
</head>
<body>
  <header>
    <strong>${esc(env.appName)}</strong>
    <span>Running <span class="mono">${esc(version)}</span> · <span class="mono">${esc(env.envName)}</span></span>
  </header>
  <main>
    <h1>A pretend web app</h1>
    <p>This tab loaded when <span class="mono">${esc(version)}</span> was live, so that is the version it runs,
      like a tab someone left open after a deploy. It checks OpenVersion every 10 seconds (and when you come
      back to it). Keep it open next to <a href="${esc(dashboard)}" target="_blank" rel="noopener">the dashboard</a>, then:</p>
    <ul>
      <li><strong>Publish a release</strong> (Publish release, or <code>npx openversion release --minor</code>): a toast
        says a new version is ready.</li>
      <li><strong>Hard refresh</strong>, or publish with <em>Hard</em>: a banner counts down from 10 and the tab reloads
        once, not in a loop.</li>
      <li><strong>Make live</strong> on an older release: the tab reloads to that version.</li>
    </ul>
    <dl class="state" aria-live="polite">
      <dt>This tab runs</dt><dd class="mono">${esc(version)}</dd>
      <dt>Live now</dt><dd class="mono" id="live">checking…</dd>
      <dt>Decision</dt><dd class="mono" id="decision">…</dd>
      <dt>Last checked</dt><dd id="checked">…</dd>
    </dl>
    <p><label>Something you were typing <input placeholder="Unsaved work is lost on a hard refresh"></label></p>
  </main>
  <ov-update></ov-update>
  <script type="module">
    import { configure } from '@openstuff-dev/version';
    import '@openstuff-dev/version/update';
    const client = configure(${config.replace(/</g, '\\u003c')});
    const words = { none: 'none: up to date', prompt: 'prompt: ask to reload', force: 'force: reload at a safe moment' };
    client.subscribe((state) => {
      document.getElementById('live').textContent = state.live?.version ?? 'nothing released';
      document.getElementById('decision').textContent = words[state.decision];
      document.getElementById('checked').textContent = state.live ? new Date().toLocaleTimeString() : '…';
    });
  </script>
</body>
</html>`;
}
