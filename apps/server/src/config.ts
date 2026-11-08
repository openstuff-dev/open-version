import type { FetchPolicy } from '@openstuff-dev/server';
/** Settings from environment variables. Each has a default, so the server starts without any. */
export interface Config {
  port: number;
  host: string;
  /** The built web app to serve next to the API, if any. */
  webDir: string | undefined;
  logLevel: string;
  databaseUrl: string;
  /** Where people and clients reach OpenVersion. Used for cookies, links and setup snippets. */
  publicUrl: string;
  /** The first admin's email and password. Without a password, one is made and logged once. */
  adminEmail: string;
  adminPassword: string | undefined;
  sessionDays: number;
  /**
   * Encrypts integration keys at rest. Without it, one is made on first start and kept in the
   * database (a dump alone then reveals the keys).
   */
  secretKey: string | undefined;
  /** `private` lets integrations reach internal addresses (only the hosts in fetchAllow). */
  fetch: 'public' | 'private';
  fetchAllow: string[];
  /** Behind a reverse proxy: true, or the proxy's addresses. */
  trustProxy: boolean | string;
  /** Serve the demo host page at /demo. */
  demo: boolean;
  /**
   * A server-wide OpenAnnounce connection from the environment. When the URL and public key are
   * both set, they win over the one saved in the Integrations tab, which then shows read-only.
   */
  openAnnounce: {
    url: string | undefined;
    publicKey: string | undefined;
    signingSecret: string | undefined;
  };
  /**
   * Version checks allowed per public key and address, per minute; 0 turns the limit off.
   * High by default: a whole office (or every user behind a proxy without
   * OPENVERSION_TRUST_PROXY) shares one address, and a refused tab misses the update until its
   * next check. 1200 a minute is about 6000 tabs checking every 5 minutes.
   */
  versionRateLimit: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const trust = env.OPENVERSION_TRUST_PROXY ?? '';
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    webDir: env.WEB_DIR || undefined,
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: env.DATABASE_URL ?? 'postgres://openversion:openversion@localhost:5432/openversion',
    publicUrl: (env.OPENVERSION_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    adminEmail: (env.OPENVERSION_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase(),
    adminPassword: env.OPENVERSION_ADMIN_PASSWORD || undefined,
    sessionDays: Number(env.OPENVERSION_SESSION_DAYS ?? 30),
    secretKey: env.OPENVERSION_SECRET_KEY || undefined,
    fetch: env.OPENVERSION_FETCH === 'private' ? 'private' : 'public',
    fetchAllow: (env.OPENVERSION_FETCH_ALLOW ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    trustProxy: trust === 'true' ? true : trust || false,
    demo: env.OPENVERSION_DEMO === 'on',
    openAnnounce: {
      url: env.OPENVERSION_OPENANNOUNCE_URL?.replace(/\/$/, '') || undefined,
      publicKey: env.OPENVERSION_OPENANNOUNCE_PUBLIC_KEY || undefined,
      signingSecret: env.OPENVERSION_OPENANNOUNCE_SIGNING_SECRET || undefined,
    },
    versionRateLimit: Number(env.OPENVERSION_VERSION_RATE_LIMIT ?? 1200),
  };
}

/** The fetch policy integrations use, from OPENVERSION_FETCH and OPENVERSION_FETCH_ALLOW. */
export const policyFrom = (config: Config): FetchPolicy => ({
  mode: config.fetch,
  allow: config.fetchAllow,
  envPrefix: 'OPENVERSION',
});
