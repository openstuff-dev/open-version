# OpenVersion

Tells open browser tabs when a new version of your web app is live.

Project page: https://version.openstuff.dev

When you ship a new version, people who already have the app open keep running the old
JavaScript. They hit stale chunks (`ChunkLoadError`), call APIs that have changed, and report bugs
you already fixed. OpenVersion fixes that:

1. **CI publishes a release** after each deploy: `npx openversion release --minor`, with the
   release notes.
2. **Your app's browser code** (`@openstuff-dev/version`) knows the version it was built as. It
   checks the live version and shows "A new version is ready" with **Reload**, or reloads by
   itself at a safe moment when the release is **hard**.
3. **From the dashboard** you can send a **hard refresh** (every open tab reloads once, after a
   bad deploy or a security fix) or **make an older release live** again.
4. **Release notes can go to [OpenAnnounce](https://github.com/openstuff-dev/open-announce)** as
   a News message, so people see what changed in the same place as your other news.

## Who does what

- **Server admins** add teams, each kept apart from the others with Postgres row-level security.
- **Admins** of a team do everything, including members and integrations.
- **Developers** add apps and environments, publish releases, send hard refreshes and manage
  keys.
- **Viewers** see apps, versions and history, and change nothing.
- **CI** holds an environment's **deploy token** (`ov_live_…`, shown once) and publishes releases.
- **Open tabs** hold only the environment's **public key** (`pk_…`), which can read the live
  version and nothing else.

## Try it

```sh
cp .env.example .env
echo OPENVERSION_DEMO=on >> .env
docker compose up -d --build
docker compose exec app node dist/seed-demo.js
```

The seed prints the demo logins (admin, developer, viewer) and each environment's keys. Open
http://localhost:8080 and sign in, and open http://localhost:8080/demo in a second window: a
pretend Shop that runs the client and checks every 10 seconds. Then:

- **Publish a release** with the printed deploy token, and the demo shows "A new version is
  ready":

  ```sh
  OPENVERSION_URL=http://localhost:8080 OPENVERSION_TOKEN=ov_live_… npx openversion release --minor
  ```

- **Hard refresh** on Shop › production (or `npx openversion refresh`): the demo counts down and
  reloads once, not in a loop.
- **Make live** on an older release: the demo reloads to that version.

Without the seed, sign in as `OPENVERSION_ADMIN_EMAIL`. The password is in the log once:
`docker compose logs app | grep "first admin"`.

## Add it to an app

Create the app on the **Apps** page. Its **Setup** tab has these snippets with your own URL and
public key filled in.

```sh
npm install @openstuff-dev/version
```

```js
import { configure } from '@openstuff-dev/version';
import '@openstuff-dev/version/update'; // <ov-update>

configure({
  url: 'https://version.example.com',
  publicKey: 'pk_…',
  version: import.meta.env.VITE_APP_VERSION, // or __APP_VERSION__, set at build time
});
```

```html
<body>
  <ov-update></ov-update>
  …
</body>
```

It checks on load, when the tab becomes visible, when it comes back online and every 5 minutes,
with `If-None-Match`, so an unchanged answer is a 304. On a stale chunk error it checks at once.
A forced reload waits for a safe moment: the tab is hidden, the person navigates, or a 30-second
countdown ends. It never reloads twice for the same version or refresh. The
[package README](packages/version/README.md) covers events for your own UI, styling and every
option.

## Publish from CI

The **Keys** tab shows the environment's deploy token once. Put it in a CI secret, then add a
step after your deploy:

```yaml
- name: Tell open tabs about the new version
  run: npx openversion release --from-package --notes-file CHANGELOG.md
  env:
    OPENVERSION_URL: https://version.example.com
    OPENVERSION_TOKEN: ${{ secrets.OPENVERSION_TOKEN }}
```

| Command | What it does |
|---|---|
| `openversion release 1.4.2` | Publishes that version. It must be higher than the live one, or the CLI exits 1 with the reason |
| `openversion release --patch` / `--minor` / `--major` | Publishes the next version after the live one |
| `openversion release --from-package` | Publishes the version in `package.json` |
| `--notes-file CHANGELOG.md` | Takes the changelog section for the version, else `Unreleased`, else the whole file |
| `--hard` | Every open tab reloads without asking |
| `openversion refresh` | Hard refresh, no new version |
| `openversion status` | Shows the live release |

With `GITHUB_SHA` (or `CI_COMMIT_SHA` and the like) set, the CLI sends an `Idempotency-Key`, so a
retried job publishes once. The API it calls is described at `/api/v1/openapi.json`.

### Post release notes to OpenAnnounce

On an environment's **Integrations** tab, switch on **Post release notes to OpenAnnounce** and
enter the OpenAnnounce URL and a system's publish key (made on that system's page in
OpenAnnounce). **Test connection** checks the key without posting. Each new release then shows in
OpenAnnounce as News, "Shop 1.4.2" with the notes. A worker posts it, retries server errors with
backoff up to 5 times, and sends the release id as the `Idempotency-Key`, so it appears once
however often it is retried. The release history shows "Posted to OpenAnnounce" or the reason it
couldn't, with **Retry**.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://openversion:openversion@localhost:5432/openversion` | The Postgres database. Compose sets it. |
| `POSTGRES_PASSWORD` | `openversion` | The database password compose uses. Change it on a server. |
| `PORT` | `8080` | The port. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. |
| `OPENVERSION_PUBLIC_URL` | `http://localhost:8080` | Where people and clients reach OpenVersion. Setup snippets and "What's new" links use it. Cookies are `Secure` when it's `https://`, and changes posted from other origins are refused. |
| `OPENVERSION_ADMIN_EMAIL` | `admin@example.com` | The first server admin, made on the first start. |
| `OPENVERSION_ADMIN_PASSWORD` | _(made and logged once)_ | That admin's password. |
| `OPENVERSION_SESSION_DAYS` | `30` | How long people stay signed in. |
| `OPENVERSION_SECRET_KEY` | _(made on first start, kept in the database, logged as a warning)_ | Encrypts integration keys at rest (AES-256-GCM). Set it on a server, so a database dump alone can't reveal them. |
| `OPENVERSION_FETCH` | `public` | `private` lets integrations reach internal addresses, such as an OpenAnnounce on the same network. |
| `OPENVERSION_FETCH_ALLOW` | _(none)_ | With `private`: the only hosts allowed to be internal, comma-separated. |
| `OPENVERSION_VERSION_RATE_LIMIT` | `1200` | Version checks per public key and network address per minute; `0` turns it off. |
| `OPENVERSION_TRUST_PROXY` | _(off)_ | Behind a reverse proxy: `true`, or the proxy's addresses. |
| `OPENVERSION_DEMO` | `off` | `on` serves the pretend app at `/demo`. |

**Behind a reverse proxy**, set `OPENVERSION_TRUST_PROXY`. Without it every tab seems to come from
the proxy's address and they all share one rate limit. A whole office behind one address shares
it too: 1200 checks a minute is about 6000 tabs at the default 5-minute interval. A tab that is
refused tries again after `Retry-After`.

**Integrations fetch only public addresses** unless `OPENVERSION_FETCH=private`. Every address a
name resolves to is checked when connecting (so DNS rebinding doesn't get around it), redirects
aren't followed, and requests time out after 10 seconds.

## Security

- The database user may be a superuser (the Docker default): every connection drops to the
  `openversion_app` role, which row-level security applies to. If it can't, the server refuses
  to start.
- The browser holds only the public key, which can read the live version from the environment's
  allowed origins and nothing else. Other origins get a 403.
- Deploy tokens are stored hashed and shown once. Regenerating one revokes the old one at once.
  A token can publish, refresh and read the live release of its environment. It can never manage
  members, teams or tokens, not even with a session cookie next to it.
- Integration keys are encrypted with `OPENVERSION_SECRET_KEY` and never sent back by the API.
- Version checks store a counter per minute (no addresses, no user data) for the live dot, and
  delete it after an hour.
- Admins can export a team to one JSON file and import it elsewhere (Settings). Keys and tokens
  aren't in the export: imported environments get new ones.

## Develop

Use Node 24 (`.nvmrc`).

```sh
npm install
docker run -d --name openversion-db -e POSTGRES_USER=openversion \
  -e POSTGRES_PASSWORD=openversion -e POSTGRES_DB=openversion -p 5432:5432 postgres:16-alpine
npx nx dev server                     # the API on http://localhost:8080
npx nx serve web                      # the app on http://localhost:4200; /api goes to the server
npx tsx apps/server/src/seed-demo.ts  # optional: the demo team
```

Before you push, run what CI runs. The server's tests need a database, which they empty first:

```sh
docker exec openversion-db psql -U openversion -c 'CREATE DATABASE openversion_test'
TEST_DATABASE_URL=postgres://openversion:openversion@localhost:5432/openversion_test \
  npx nx run-many -t lint stylelint typecheck test build
```

Without `TEST_DATABASE_URL` those tests are skipped.

## Layout

| Folder | What's in it |
|---|---|
| `apps/web` | The dashboard (Angular, on the OpenStuff toolkit): apps, environments, releases, keys, integrations, members |
| `apps/server` | The Fastify API, `/api/v1` for open tabs and CI, the outbox worker, the migrations, `/demo` and the demo seed. In production it also serves the dashboard and the browser package at `/sdk/` |
| `packages/version` | `@openstuff-dev/version` (published): `decide` and semver, the browser client, `<ov-update>` and the `openversion` CLI |
| `packages/contracts` | `@open-version/contracts`: the API's types, re-exporting `decide` and semver |

## License

MIT
