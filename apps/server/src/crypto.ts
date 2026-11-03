import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Pool } from './db.js';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const newPublicKey = () => `pk_${randomBytes(18).toString('base64url')}`;

/** `ov_live_…` for production, `ov_test_…` for every other environment. */
export function newDeployToken(environment: string): string {
  const prefix = environment === 'production' ? 'ov_live_' : 'ov_test_';
  return prefix + randomBytes(30).toString('base64url');
}

/** `ov_live_••••3f9a`: enough to tell tokens apart, never enough to use one. */
export function tokenHint(token: string, last4 = token.slice(-4)): string {
  const prefix = token.startsWith('ov_live_') ? 'ov_live_' : 'ov_test_';
  return `${prefix}••••${last4}`;
}

/** Encrypts and decrypts integration keys with AES-256-GCM. */
export interface Vault {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function vaultFor(secret: string): Vault {
  const key = createHash('sha256').update(secret).digest();
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
    },
    open(sealed) {
      const parts = sealed.split('.');
      if (parts.length !== 3) throw new Error('This key is damaged. Enter it again.');
      const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('This key can’t be read with the current OPENVERSION_SECRET_KEY. Enter it again.');
      }
    },
  };
}

/**
 * The vault for OPENVERSION_SECRET_KEY. Without that setting, a key is made on first start and
 * kept in the database, with a warning: a database dump alone could then reveal the keys.
 */
export async function loadVault(
  pool: Pool,
  config: Config,
  log: FastifyBaseLogger,
): Promise<Vault> {
  if (config.secretKey) return vaultFor(config.secretKey);
  const fresh = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<{ value: string; inserted: boolean }>(
    `INSERT INTO server_settings (name, value) VALUES ('secret_key', $1)
     ON CONFLICT (name) DO UPDATE SET value = server_settings.value
     RETURNING value, (xmax = 0) AS inserted`,
    [fresh],
  );
  const row = rows[0];
  log.warn(
    (row.inserted ? 'Made a secret key and stored it in the database. ' : '') +
    'OPENVERSION_SECRET_KEY isn’t set, so integration keys are encrypted with a key kept in the ' +
    'database. Set OPENVERSION_SECRET_KEY on a server, so a database dump alone can’t reveal them.',
  );
  return vaultFor(row.value);
}
