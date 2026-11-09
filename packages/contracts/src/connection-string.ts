import {
  ConnectionStringError,
  isConnectionString,
  makeConnectionString,
  parseConnectionString,
} from '@openstuff-dev/server/connection-string';
import type { Environment } from './index.js';

/** A connection string with where to paste it, as `SecretDialog`'s `connection` takes it. */
export interface Connection {
  value: string;
  instructions: string;
}

/**
 * The connection string for another OpenStuff app's Settings › Integrations: this server's address
 * (`url`, the page's origin in the web app), the environment's public key and its deploy token. It
 * holds the token, so show it once.
 */
export function connectionFor(
  env: Environment,
  deployToken: string,
  url: string,
): Connection {
  const origins = env.allowedOrigins.length
    ? ' Add that app’s address to Allowed origins on the Keys tab too, or it can’t check its version.'
    : '';
  return {
    value: makeConnectionString('openversion', { url, publicKey: env.publicKey, deployToken }),
    instructions: `To connect another OpenStuff app, paste this in its Settings › Integrations, on the OpenVersion card.${origins}`,
  };
}

/** What a paste into a publish key field means. */
export type PublishKeyPaste =
  | { kind: 'key' } |
  { kind: 'connection'; url: string; publishKey: string } |
  { kind: 'error'; message: string };

/**
 * Reads a paste into a publish key field. An OpenAnnounce connection string fills in the address
 * and the key; anything else is the key itself.
 */
export function readPublishKeyPaste(text: string): PublishKeyPaste {
  if (!isConnectionString(text, 'openannounce') && !isConnectionString(text, 'openversion')) {
    return { kind: 'key' };
  }
  try {
    const { url, publishKey } = parseConnectionString(text, 'openannounce');
    if (!publishKey) {
      return {
        kind: 'error',
        message:
          'That connection string has no publish key. In OpenAnnounce, make a publish key on the system’s Setup tab and copy the string shown with it.',
      };
    }
    return { kind: 'connection', url, publishKey };
  } catch (error) {
    if (error instanceof ConnectionStringError) return { kind: 'error', message: error.message };
    throw error;
  }
}
