-- OpenVersion: tells open browser tabs when a new version of a web app is live.
--
--   teams                        the tenant, with its members and apps
--     ├─ members                 who signs in: admins, developers and viewers
--     ├─ apps                    a web app the team runs
--     │   └─ environments        one deployment (production, staging) with its keys and live release
--     │       ├─ releases        versions published to it, and rollbacks
--     │       ├─ client_pings    version checks per minute (no IPs), for the live dot
--     │       └─ integrations    where release notes go (OpenAnnounce)
--     └─ outbox                  release notes waiting to be posted, with retries
--
-- Every team table has row-level security: a request only sees the team it was opened for
-- (openversion.team_id), so a query that forgets its WHERE clause can't leak another team.

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE CHECK (email = lower(email)),
  name            text NOT NULL DEFAULT '',
  password_hash   text NOT NULL,
  is_server_admin boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TYPE member_role AS ENUM ('admin', 'developer', 'viewer');

CREATE TABLE members (
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role       member_role NOT NULL,
  PRIMARY KEY (team_id, account_id)
);
CREATE INDEX members_account ON members(account_id);

CREATE TABLE apps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug       text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  base_url   text NOT NULL CHECK (base_url ~ '^https?://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, slug)
);

CREATE TYPE refresh_policy AS ENUM ('prompt', 'force');

CREATE TABLE environments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id            uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  app_id             uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  public_key         text NOT NULL UNIQUE,
  -- SHA-256 of the deploy token. The token itself is shown once and never stored.
  deploy_token_hash  text NOT NULL UNIQUE,
  -- ov_live_ or ov_test_, as made; the hint shows it with the last four characters.
  deploy_token_prefix text NOT NULL CHECK (deploy_token_prefix IN ('ov_live_', 'ov_test_')),
  deploy_token_last4 text NOT NULL,
  allowed_origins    text[] NOT NULL DEFAULT '{}',
  refresh_policy     refresh_policy NOT NULL DEFAULT 'prompt',
  refresh_epoch      int NOT NULL DEFAULT 0,
  live_release_id    uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);

CREATE TYPE release_source AS ENUM ('cli', 'api', 'web');

CREATE TABLE releases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  version        text NOT NULL CHECK (length(version) BETWEEN 5 AND 100),
  notes          text NOT NULL DEFAULT '' CHECK (length(notes) <= 20000),
  hard           boolean NOT NULL DEFAULT false,
  source         release_source NOT NULL,
  -- A member's name, or "Deploy token". Kept as text so history survives removed members.
  created_by     text NOT NULL,
  -- A rollback is recorded like a release that points at the release it made live again.
  rollback_of    uuid REFERENCES releases(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Each version is published once per environment; rollbacks repeat an earlier version.
CREATE UNIQUE INDEX releases_version ON releases(environment_id, version) WHERE rollback_of IS NULL;
CREATE INDEX releases_history ON releases(environment_id, created_at DESC);

ALTER TABLE environments ADD CONSTRAINT environments_live_release
  FOREIGN KEY (live_release_id) REFERENCES releases(id) ON DELETE SET NULL;

-- Version checks per environment and minute. No IPs, no user data; pruned after an hour.
CREATE TABLE client_pings (
  team_id        uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  minute         timestamptz NOT NULL,
  count          int NOT NULL DEFAULT 0,
  PRIMARY KEY (environment_id, minute)
);

CREATE TYPE integration_kind AS ENUM ('open-announce');

CREATE TABLE integrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id               uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  environment_id        uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  kind                  integration_kind NOT NULL,
  url                   text NOT NULL CHECK (url ~ '^https?://'),
  -- AES-256-GCM with OPENVERSION_SECRET_KEY: iv.tag.ciphertext, base64url.
  publish_key_encrypted text,
  groups                text[] NOT NULL DEFAULT '{}',
  enabled               boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, kind)
);

CREATE TYPE outbox_status AS ENUM ('pending', 'sent', 'failed');

CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  release_id      uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  status          outbox_status NOT NULL DEFAULT 'pending',
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, release_id)
);
CREATE INDEX outbox_due ON outbox(next_attempt_at) WHERE status = 'pending';

-- Answers to POSTs with an Idempotency-Key, per caller (an account or a deploy token), for a day.
CREATE TABLE idempotency_keys (
  caller       text NOT NULL,
  key          text NOT NULL,
  path         text NOT NULL,
  request_hash text NOT NULL,
  status       int,
  body         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, key)
);

-- Server-wide values, e.g. the generated secret key when OPENVERSION_SECRET_KEY isn't set.
CREATE TABLE server_settings (
  name  text PRIMARY KEY,
  value text NOT NULL
);

-- Row-level security ------------------------------------------------------------------------

CREATE FUNCTION openversion_team() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('openversion.team_id', true), '')::uuid $$;
CREATE FUNCTION openversion_bypass() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('openversion.bypass', true), '') = 'on' $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['apps', 'environments', 'releases', 'client_pings', 'integrations',
                           'outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY team_isolation ON %I
      USING (openversion_bypass() OR team_id = openversion_team())
      WITH CHECK (openversion_bypass() OR team_id = openversion_team())', t);
  END LOOP;
END $$;

-- The role every request runs as. Superusers skip row-level security, so the server switches
-- to this role on each connection (see createPool in src/db.ts).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openversion_app') THEN
    CREATE ROLE openversion_app NOLOGIN;
  END IF;
END $$;
