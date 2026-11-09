import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The logic is tested in packages/contracts/test/connection-string.test.ts; these check the pages.
const web = (path: string) =>
  readFileSync(new URL(`../../web/src/app/pages/${path}`, import.meta.url), 'utf8');

describe('getting a connection string', () => {
  it('UC-7/S1 shows a new token once, in the secret dialog with its connection string', () => {
    const setup = web('environment/setup-tab.ts');
    expect(setup).toContain('this.secret.show(');
    expect(setup).toContain('connection: connectionFor(');
    // The token no longer stays on the page in a callout.
    expect(setup).not.toContain('os-callout');
  });

  it('UC-7/S2 says the token is replaced because only its hash is kept, and that CI needs the new one', () => {
    const keys = web('environment/keys-tab.ts');
    expect(keys).toContain('Get a connection string');
    expect(keys).toContain('OpenVersion keeps only a hash of the deploy token');
    expect(keys).toContain('CI needs the new token in its secret');
  });

  it('UC-7/S3 offers a new connection string on regenerate and says the old token stopped working', () => {
    const keys = web('environment/keys-tab.ts');
    expect(keys).toContain('The old token stopped working.');
    expect(keys).toContain('connection: connectionFor(');
    expect(keys).not.toContain('os-callout');
  });

  it('UC-7/S4 says on the Keys tab that a connected app must be in the allowed origins', () => {
    expect(web('environment/keys-tab.ts')).toContain(
      'An app you connect with a connection string must be in this list too',
    );
  });

  it('UC-7/S5 reads a pasted OpenAnnounce string in both publish key fields', () => {
    for (const page of ['environment/integrations-tab.ts', 'settings/integrations.ts']) {
      expect(web(page)).toContain('(ngModelChange)="keyChanged($event)"');
    }
  });
});
