import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Vault } from '@openstuff-dev/server';
import { requireAccount } from '../auth.js';
import type { Config } from '../config.js';
import type { Pool } from '../db.js';
import { HttpError } from '../errors.js';
import { checkOpenAnnounceFeed, PostError } from '../openannounce.js';
import { baseUrl } from './shared.js';

/** One server-wide connection, as the Integrations tab shows it. Secrets are never included. */
export interface ServerIntegration {
  kind: 'openannounce';
  url: string | null;
  publicKey: string | null;
  hasSigningSecret: boolean;
  status: 'not-connected' | 'connected' | 'problem' | 'set-by-server';
  source: 'database' | 'environment' | null;
  message: string | null;
  testedAt: string | null;
}

const publicKey = z.string().trim().min(8, 'Paste the whole public key.').max(200);
const signingSecret = z.string().trim().min(8, 'Paste the whole signing secret.').max(500);

interface Row {
  url: string;
  public_key: string;
  has_secret: boolean;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  last_tested_at: Date | null;
}

export function registerServerIntegrationRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: Config,
  vault: () => Promise<Vault>,
  check: (url: string, publicKey: string, origin: string) => Promise<string> = (url, key, origin) =>
    checkOpenAnnounceFeed(policy(config), url, key, origin),
): void {
  const origin = new URL(config.publicUrl).origin;
  const fromEnv =
    config.openAnnounce.url && config.openAnnounce.publicKey
      ? { url: config.openAnnounce.url, publicKey: config.openAnnounce.publicKey }
      : null;
  const envSet = fromEnv !== null;

  const serverAdmin = (request: Parameters<typeof requireAccount>[0]) => {
    const account = requireAccount(request);
    if (!account.isServerAdmin) throw new HttpError(403, 'Only a server admin can manage server connections.');
  };

  const loadRow = async (): Promise<Row | undefined> => {
    const { rows } = await pool.query<Row>(
      `SELECT url, public_key, signing_secret_encrypted IS NOT NULL AS has_secret, last_test_ok,
              last_test_message, last_tested_at FROM server_integrations WHERE kind = 'openannounce'`,
    );
    return rows[0];
  };

  const card = (row: Row | undefined): ServerIntegration => {
    if (fromEnv) {
      return {
        kind: 'openannounce',
        url: fromEnv.url,
        publicKey: fromEnv.publicKey,
        hasSigningSecret: config.openAnnounce.signingSecret !== undefined,
        status: 'set-by-server',
        source: 'environment',
        message: null,
        testedAt: null,
      };
    }
    if (!row) {
      return {
        kind: 'openannounce',
        url: null,
        publicKey: null,
        hasSigningSecret: false,
        status: 'not-connected',
        source: null,
        message: null,
        testedAt: null,
      };
    }
    return {
      kind: 'openannounce',
      url: row.url,
      publicKey: row.public_key,
      hasSigningSecret: row.has_secret,
      status: row.last_test_ok === false ? 'problem' : 'connected',
      source: 'database',
      message: row.last_test_message,
      testedAt: row.last_tested_at?.toISOString() ?? null,
    };
  };

  /** Runs the check and says what it found: never throws for a failed check. */
  const runCheck = async (url: string, key: string): Promise<{ ok: boolean; message: string }> => {
    try {
      return { ok: true, message: await check(url, key, origin) };
    } catch (err) {
      if (err instanceof PostError) return { ok: false, message: err.message };
      throw err;
    }
  };

  app.get('/api/admin/integrations', async (request): Promise<ServerIntegration[]> => {
    serverAdmin(request);
    return [card(await loadRow())];
  });

  /** Saves the connection, then tests it. The save happens either way, so a fix can follow. */
  app.put('/api/admin/integrations/openannounce', async (request): Promise<ServerIntegration> => {
    serverAdmin(request);
    if (envSet) {
      throw new HttpError(409, 'The server’s configuration sets this. Change OPENVERSION_OPENANNOUNCE_URL to change it here.');
    }
    const body = z
      .object({ url: baseUrl, publicKey, signingSecret: signingSecret.optional() })
      .parse(request.body);
    const result = await runCheck(body.url, body.publicKey);
    const sealed = body.signingSecret ? (await vault()).seal(body.signingSecret) : null;
    await pool.query(
      `INSERT INTO server_integrations (kind, url, public_key, signing_secret_encrypted, last_test_ok, last_test_message, last_tested_at, updated_at)
       VALUES ('openannounce', $1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (kind) DO UPDATE SET url = EXCLUDED.url, public_key = EXCLUDED.public_key,
         signing_secret_encrypted = coalesce($3, server_integrations.signing_secret_encrypted),
         last_test_ok = EXCLUDED.last_test_ok, last_test_message = EXCLUDED.last_test_message,
         last_tested_at = now(), updated_at = now()`,
      [body.url, body.publicKey, sealed, result.ok, result.message],
    );
    return card(await loadRow());
  });

  /** Tests the saved connection, or the values sent, without saving anything new. */
  /** Tests the saved connection, or the values sent. Saved results are kept; new values are not. */
  async function testConnection(
    request: Parameters<typeof requireAccount>[0],
  ): Promise<{ ok: boolean; message: string }> {
    serverAdmin(request);
    const body = z
      .object({ url: baseUrl.optional(), publicKey: publicKey.optional() })
      .parse(request.body ?? {});
    const saved = await loadRow();
    const url = body.url ?? (fromEnv ? fromEnv.url : saved?.url);
    const key = body.publicKey ?? (fromEnv ? fromEnv.publicKey : saved?.public_key);
    if (!url || !key) {
      throw new HttpError(400, 'Enter the OpenAnnounce address and public key first.');
    }
    const result = await runCheck(url, key);
    const testsSaved = !envSet && saved !== undefined && !body.url && !body.publicKey;
    if (testsSaved) {
      await pool.query(
        `UPDATE server_integrations SET last_test_ok = $1, last_test_message = $2, last_tested_at = now()
         WHERE kind = 'openannounce'`,
        [result.ok, result.message],
      );
    }
    return result;
  }

  app.post('/api/admin/integrations/openannounce/test', (request) => testConnection(request));

  app.delete('/api/admin/integrations/openannounce', async (request): Promise<{ ok: true }> => {
    serverAdmin(request);
    if (envSet) {
      throw new HttpError(409, 'The server’s configuration sets this. Remove OPENVERSION_OPENANNOUNCE_URL to disconnect it here.');
    }
    await pool.query("DELETE FROM server_integrations WHERE kind = 'openannounce'");
    return { ok: true };
  });

  /** Public values only, so the web app can load its OpenAnnounce client. Never a secret. */
  app.get('/api/client-config', async (): Promise<{ openannounce: { url: string; publicKey: string } | null }> => {
    if (fromEnv) return { openannounce: fromEnv };
    const row = await loadRow();
    return { openannounce: row ? { url: row.url, publicKey: row.public_key } : null };
  });
}

const policy = (config: Config) => ({ mode: config.fetch, allow: config.fetchAllow, envPrefix: 'OPENVERSION' }) as const;
