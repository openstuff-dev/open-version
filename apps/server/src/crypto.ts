import { createHash, randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { loadVault as loadSharedVault, type Vault } from '@openstuff-dev/server';
import type { Config } from './config.js';
import type { Pool } from './db.js';

export type { Vault };

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

/** The vault for OPENVERSION_SECRET_KEY, from the shared server package. */
export function loadVault(pool: Pool, config: Config, log: FastifyBaseLogger): Promise<Vault> {
  return loadSharedVault(pool, {
    secret: config.secretKey,
    envName: 'OPENVERSION_SECRET_KEY',
    settingName: 'secret_key',
    log,
  });
}
