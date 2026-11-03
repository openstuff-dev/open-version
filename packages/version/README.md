# @openstuff-dev/version

Tell open browser tabs that a new version of your web app is live, with
[OpenVersion](https://github.com/openstuff-dev/open-version). People who keep a tab open stop
running old JavaScript: no more `ChunkLoadError`, calls to changed APIs, or bug reports about
bugs you already fixed.

```sh
npm install @openstuff-dev/version
```

| Import | What it is |
|---|---|
| `@openstuff-dev/version` | `configure`, the client, the types and the reload rules (`decide`, semver helpers). Safe in Node. |
| `@openstuff-dev/version/update` | `<ov-update>`: a toast "A new version is ready" and the countdown banner for hard releases |
| `npx openversion` | The CLI for CI: publish a release, hard refresh, status |

## Set it up

Give your build its version at build time, then configure the client once, early:

```js
import { configure } from '@openstuff-dev/version';
import '@openstuff-dev/version/update'; // <ov-update>

configure({
  url: 'https://version.example.com', // your OpenVersion server
  publicKey: 'pk_…', // the environment's public key, from its Setup tab
  version: import.meta.env.VITE_APP_VERSION, // or __APP_VERSION__, set at build time
  interval: 300, // seconds between checks while the tab is visible; 0 turns the timer off
  countdown: 30, // seconds the banner counts down before a hard reload
});
```

```html
<ov-update></ov-update>
```

With Vite, for example: `define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.npm_package_version) }`.

Instead of `configure`, `<ov-update>` also takes `url`, `public-key` and `version` attributes.
No bundler? Load it from your OpenVersion server:

```html
<script type="importmap">
  { "imports": { "@openstuff-dev/version": "https://version.example.com/sdk/core/index.js",
                 "@openstuff-dev/version/update": "https://version.example.com/sdk/update/index.js" } }
</script>
```

## What it does

- Checks the live version on load, when the tab becomes visible, when it comes back online, and
  every `interval` seconds. One request per tab, with `If-None-Match`, so an unchanged answer is
  a 304.
- **A new version** (or a rollback to an older one): `<ov-update>` shows "A new version is
  ready." with **Reload** and **What's new** (the release notes). Closing it hides it until the
  next version.
- **A hard release or a hard refresh** (or an environment set to reload automatically): the tab
  reloads at the next safe moment: when it is hidden, on the next navigation, or after a
  30-second banner with **Reload now**.
- It never reloads twice for the same version or refresh in a tab, so a deploy that still serves
  the old files can't make it loop. It asks instead.
- **Stale chunks**: on `vite:preloadError`, a `ChunkLoadError` or a failed dynamic `import()`, it
  checks at once and reloads if the version changed.

## Your own UI

Leave out `<ov-update>` and listen on `window`:

| Event | `detail` | When |
|---|---|---|
| `ov-update-available` | `{ live, running }` | A different version is live; ask people to reload |
| `ov-update-forced` | `{ live, running, reloadAt }` | The tab will reload at `reloadAt` (ms). Cancelable: call `preventDefault()` to reload yourself, e.g. after saving a form |

```js
const client = configure({ /* … */ });
client.subscribe((state) => console.log(state.decision)); // 'none' | 'prompt' | 'force'
client.reload(); // reload now
client.dismiss(); // hide the prompt until the next version
```

## Make it look like your app

```css
ov-update {
  --ov-font: inherit;
  --ov-radius: 4px;
  --ov-accent: #0a7;
  --ov-accent-fg: #fff;
  --ov-bg: #fff;
  --ov-fg: #111;
  --ov-border: #ddd;
  --ov-banner-bg: #fff6db;
}

ov-update::part(toast) { inset: auto auto 24px 24px; }
```

Parts: `toast`, `banner`, `message`, `actions`, `button`, `reload`, `notes`, `close`,
`countdown`. Change the words with attributes: `message`, `forced-message` (`{s}` is the
countdown), `reload-label`, `notes-label`, `reload-now-label`, `close-label`.

## Publish from CI

The CLI reads `OPENVERSION_URL` and `OPENVERSION_TOKEN` (the environment's deploy token, from its
Keys tab; keep it in a CI secret).

```sh
npx openversion release --minor --notes-file CHANGELOG.md   # 1.4.2 → 1.5.0
npx openversion release 1.5.0 --hard                       # every open tab reloads
npx openversion release --from-package                     # the version in package.json
npx openversion refresh                                    # hard refresh, no new version
npx openversion status                                     # the live release
```

`--notes-file` takes the changelog section for the version (`## 1.5.0` or `## [1.5.0] - date`),
else the `Unreleased` section, else the whole file. A version that isn't higher than the live
one is refused, and the CLI exits 1 with the reason. With `GITHUB_SHA` (or `CI_COMMIT_SHA`
and the like) set, it sends an `Idempotency-Key`, so a retried job publishes once.

### GitHub Actions

Add a step after your deploy:

```yaml
- name: Tell open tabs about the new version
  run: npx openversion release --from-package --notes-file CHANGELOG.md
  env:
    OPENVERSION_URL: https://version.example.com
    OPENVERSION_TOKEN: ${{ secrets.OPENVERSION_TOKEN }}
```

## Licence

MIT
