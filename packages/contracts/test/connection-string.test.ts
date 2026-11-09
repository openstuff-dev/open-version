import { makeConnectionString, parseConnectionString } from '@openstuff-dev/server/connection-string';
import { describe, expect, it } from 'vitest';
import { connectionFor, type Environment, readPublishKeyPaste } from '../src/index.js';

const env = (allowedOrigins: string[] = []) =>
  ({ publicKey: 'pk_env_1234', allowedOrigins }) as unknown as Environment;

describe('connection strings', () => {
  it('UC-7/S1 holds the address, the public key and the deploy token', () => {
    const { value } = connectionFor(env(), 'ov_live_secret', 'https://version.example.com');
    expect(parseConnectionString(value, 'openversion')).toEqual({
      url: 'https://version.example.com',
      publicKey: 'pk_env_1234',
      deployToken: 'ov_live_secret',
    });
  });

  it('UC-7/S4 says the other app’s address must be in the allowed origins, when there are any', () => {
    const listed = connectionFor(env(['https://shop.example.com']), 't', 'https://v.example.com');
    expect(listed.instructions).toContain('Add that app’s address to Allowed origins');
    expect(connectionFor(env(), 't', 'https://v.example.com').instructions).not.toContain(
      'Allowed origins',
    );
  });

  it('UC-7/S5 fills in the address and the publish key from an OpenAnnounce connection string', () => {
    const pasted = makeConnectionString('openannounce', {
      url: 'https://announce.example.com',
      publicKey: 'pk_sys_1',
      publishKey: 'ak_publish_1',
    });
    expect(readPublishKeyPaste(pasted)).toEqual({
      kind: 'connection',
      url: 'https://announce.example.com',
      publishKey: 'ak_publish_1',
    });
    expect(readPublishKeyPaste('ak_publish_1')).toEqual({ kind: 'key' });
  });

  it('UC-7/S5 explains a string without a publish key, or one from OpenVersion', () => {
    const noKey = makeConnectionString('openannounce', { url: 'https://a.example.com', publicKey: 'pk' });
    const result = readPublishKeyPaste(noKey);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('no publish key');
    const own = makeConnectionString('openversion', { url: 'https://v.example.com', publicKey: 'pk' });
    expect(readPublishKeyPaste(own)).toEqual({
      kind: 'error',
      message: 'That’s a connection string from OpenVersion. Paste one from OpenAnnounce.',
    });
  });
});
