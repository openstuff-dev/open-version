import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('starts with defaults when no variables are set', () => {
    expect(loadConfig({})).toEqual({
      port: 8080,
      host: '0.0.0.0',
      webDir: undefined,
      logLevel: 'info',
      databaseUrl: 'postgres://openversion:openversion@localhost:5432/openversion',
      publicUrl: 'http://localhost:8080',
      adminEmail: 'admin@example.com',
      adminPassword: undefined,
      sessionDays: 30,
      secretKey: undefined,
      fetch: 'public',
      fetchAllow: [],
      trustProxy: false,
      demo: false,
      openAnnounce: { url: undefined, publicKey: undefined, signingSecret: undefined },
      versionRateLimit: 1200,
    });
  });

  it('turns the version-check limit off with 0', () => {
    expect(loadConfig({ OPENVERSION_VERSION_RATE_LIMIT: '0' }).versionRateLimit).toBe(0);
  });

  it('reads the fetch allowlist and trims the public URL', () => {
    const config = loadConfig({
      OPENVERSION_PUBLIC_URL: 'https://version.example.com/',
      OPENVERSION_FETCH: 'private',
      OPENVERSION_FETCH_ALLOW: 'announce.internal, Other.Internal ',
    });
    expect(config.publicUrl).toBe('https://version.example.com');
    expect(config.fetch).toBe('private');
    expect(config.fetchAllow).toEqual(['announce.internal', 'other.internal']);
  });
});
