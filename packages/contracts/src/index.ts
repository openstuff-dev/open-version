// Types shared by the OpenVersion server and web app. The reload rules and the semver helpers
// live in the published @openstuff-dev/version (the browser and the CLI need them too) and are
// re-exported here, so there is still one source.
export {
  bump,
  compareVersions,
  decide,
  HARD_REFRESH_TIMING,
  formatVersion,
  isVersion,
  parseVersion,
  sameVersion,
  type Bump,
  type Decision,
  type LiveState,
  type RefreshPolicy,
  type Version,
  type VersionInfo,
} from '@openstuff-dev/version';

import type { RefreshPolicy } from '@openstuff-dev/version';

/** What a member may do in a team. */
export type Role = 'admin' | 'developer' | 'viewer';

/** Roles that may change apps, environments, releases and keys. */
export const WRITERS: readonly Role[] = ['admin', 'developer'];
export const EVERYONE: readonly Role[] = ['admin', 'developer', 'viewer'];

export type ReleaseSource = 'cli' | 'api' | 'web';

export interface Me {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
  teams: { slug: string; name: string; role: Role }[];
}

export interface Team {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

export interface Member {
  accountId: string;
  email: string;
  name: string;
  role: Role;
}

/** Returned once, when an account is made for a new member. */
export interface NewMember extends Member {
  password: string | null;
}

/** How many tabs checked in lately, for the live dot. */
export interface Activity {
  /** Version checks in the last 5 minutes, about one per open tab. */
  recentChecks: number;
}

/** One environment's row on the Apps page. */
export interface EnvironmentSummary extends Activity {
  id: string;
  name: string;
  liveVersion: string | null;
  liveHard: boolean;
  lastReleasedAt: string | null;
}

export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  baseUrl: string;
  environments: EnvironmentSummary[];
}

export interface Environment extends Activity {
  id: string;
  appId: string;
  appSlug: string;
  appName: string;
  baseUrl: string;
  name: string;
  publicKey: string;
  /** `ov_live_••••3f9a`: the prefix and the last four characters, never the token. */
  tokenHint: string;
  allowedOrigins: string[];
  refreshPolicy: RefreshPolicy;
  refreshEpoch: number;
  live: Release | null;
  createdAt: string;
}

/** Returned once, when an environment is made or its deploy token is regenerated. */
export interface EnvironmentWithToken extends Environment {
  deployToken: string;
}

export interface NewApp {
  app: AppSummary;
  /** Each new environment, with its deploy token, shown this once. */
  environments: EnvironmentWithToken[];
}

/** What happened to a release's notes in an integration. */
export interface Delivery {
  integrationId: string;
  kind: IntegrationKind;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
}

export interface Release {
  id: string;
  version: string;
  notes: string;
  hard: boolean;
  source: ReleaseSource;
  /** Who published it: a member's name, or "Deploy token". */
  createdBy: string;
  /** For a rollback: the release it made live again. */
  rollbackOf: string | null;
  createdAt: string;
  deliveries: Delivery[];
}

export type IntegrationKind = 'open-announce';

export interface Integration {
  id: string;
  environmentId: string;
  appName: string;
  environmentName: string;
  appSlug: string;
  kind: IntegrationKind;
  url: string;
  /** Whether a publish key is saved. The key itself is never sent back. */
  hasKey: boolean;
  groups: string[];
  enabled: boolean;
  /** How the last few posts went. */
  failed: number;
  sent: number;
  lastError: string | null;
}

export interface TeamExport {
  format: 'openversion-export';
  version: 1;
  exportedAt: string;
  /** Keys and tokens are not in the file; imported environments get new ones. */
  note: string;
  team: { slug: string; name: string };
  apps: {
    slug: string;
    name: string;
    baseUrl: string;
    environments: {
      name: string;
      allowedOrigins: string[];
      refreshPolicy: RefreshPolicy;
      releases: {
        version: string;
        notes: string;
        hard: boolean;
        source: ReleaseSource;
        createdAt: string;
        live: boolean;
      }[];
      integrations: { kind: IntegrationKind; url: string; groups: string[]; enabled: boolean }[];
    }[];
  }[];
}

/** What `POST /api/v1/releases` takes. Give a version or a bump, not both. */
export interface PublishRelease {
  version?: string;
  bump?: 'major' | 'minor' | 'patch';
  notes?: string;
  hard?: boolean;
}

/** What the CI API answers for a release. */
export interface PublishedRelease {
  id: string;
  version: string;
  hard: boolean;
  notes: string;
  createdAt: string;
  app: string;
  environment: string;
}

export { connectionFor, readPublishKeyPaste, type Connection, type PublishKeyPaste } from './connection-string.js';
