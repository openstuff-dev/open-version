# Changelog

Each release is a Docker image at `ghcr.io/openstuff-dev/open-version:<version>`.
Migrations run when the new version starts and only move forward, so back up first.

## 0.2.0

Migrations `002_server_integrations` and `003_server_integrations_shape` add the server's
connections table. Back up first.

### Web app

- Members, Teams, Integrations and Export are now tabs in Settings, with the team's name and
  appearance.
- Every new deploy token comes with a connection string, and the Keys tab has Get a connection
  string. Paste it into another OpenStuff app's Integrations tab to connect it. Getting one replaces
  the token in use, and the dialog says that CI needs the new one.
- The publish key fields also read a pasted OpenAnnounce connection string.
- New on Integrations: server admins paste a connection string from OpenAnnounce and see straight
  away whether it works and how to fix it. With it, OpenAnnounce messages show for the team and role
  someone is in, and the card lists the groups to create.
- Admins add release notes for an app's environment straight from Integrations, with an Add button
  that picks the app and environment.
- Moved onto `@openstuff-dev/ui` 0.1.8 and `ui-angular` 0.1.9.

### Server

- New settings: `OPENVERSION_FETCH_ALLOW` lets a connection reach listed private addresses.
  `OPENVERSION_OPENANNOUNCE_*` sets the OpenAnnounce connection from the environment, and its card
  becomes read only. Changing `OPENVERSION_SECRET_KEY` means entering the saved keys again.
- Saved connection secrets never leave the server: not in the admin list, not in an export.

### Image

- The image carries its own version (`VERSION` build arg), so the server reports it.

## 0.1.1

No migrations.

- Hard refresh now says what really happens: visible tabs reload after their next check, and background tabs when they're shown again.
- Moved onto `@openstuff-dev/ui` and `ui-angular` 0.1.6.

## 0.1.0

The first release with a published image.
