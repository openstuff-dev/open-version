import { HARD_REFRESH_TIMING } from '../src/core/decide.js';
import { describe, expect, it, vi } from 'vitest';
import { type Io, notesFor, run } from '../src/cli/index.js';

const RELEASE = {
  id: 'r1',
  version: '1.5.0',
  hard: false,
  notes: '',
  createdAt: '2026-11-03T10:00:00.000Z',
  app: 'Shop',
  environment: 'production',
};

function io(
  env: Record<string, string> = {},
  files: Record<string, string> = {},
  status = 201,
  answer: unknown = RELEASE,
) {
  const lines: string[] = [];
  const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer), { status })));
  const value: Io = {
    env: { OPENVERSION_URL: 'https://version.test/', OPENVERSION_TOKEN: 'ov_live_abc', ...env },
    fetch: fetch,
    readFile: (path) =>
      path in files ? Promise.resolve(files[path]) : Promise.reject(new Error('ENOENT')),
    out: (line) => lines.push(line),
  };
  const sent = () => {
    const [url, init] = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
    return {
      url,
      init,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(typeof init.body === 'string' ? init.body : 'null') as unknown,
    };
  };
  return { io: value, lines, sent, fetch };
}

describe('openversion release', () => {
  it('publishes a bump with the token and an Idempotency-Key from the commit', async () => {
    const t = io({ GITHUB_SHA: 'abc123' });
    expect(await run(['release', '--minor'], t.io)).toBe(0);
    const { url, headers, body } = t.sent();
    expect(url).toBe('https://version.test/api/v1/releases');
    expect(headers.authorization).toBe('Bearer ov_live_abc');
    expect(headers['idempotency-key']).toBe('release-abc123');
    expect(body).toEqual({ bump: 'minor' });
    expect(t.lines[0]).toContain('Published Shop production: 1.5.0');
  });

  it('publishes an exact version, hard, with notes from the changelog section', async () => {
    const changelog = '# Changelog\n\n## [1.5.0] - 2026-11-03\n\n- Dark mode\n\n## 1.4.0\n\n- Old';
    const t = io({}, { 'CHANGELOG.md': changelog });
    expect(await run(['release', '1.5.0', '--hard', '--notes-file', 'CHANGELOG.md'], t.io)).toBe(0);
    expect(t.sent().body).toEqual({ version: '1.5.0', notes: '- Dark mode', hard: true });
    expect(t.sent().headers['idempotency-key']).toBeUndefined();
  });

  it('reads the version from package.json', async () => {
    const t = io({}, { 'package.json': '{"version":"2.0.0"}' });
    expect(await run(['release', '--from-package'], t.io)).toBe(0);
    expect(t.sent().body).toEqual({ version: '2.0.0' });
  });

  it('publishes the next patch with no version', async () => {
    const t = io();
    await run(['release'], t.io);
    expect(t.sent().body).toEqual({ bump: 'patch' });
  });

  it.each([
    [['release', 'latest'], 'isn’t a version'],
    [['release', '1.0.0', '--minor'], 'Give one version'],
    [['release', '--minor', '--major'], 'Give one version'],
    [['release', '--notes-file', 'missing.md'], 'Couldn’t read missing.md'],
    [['deploy'], 'Unknown command'],
  ])('refuses %j with a plain message', async (argv, message) => {
    const t = io();
    expect(await run(argv, t.io)).toBe(1);
    expect(t.lines.join('\n')).toContain(message);
  });

  it('exits 1 with the server’s message on a 409', async () => {
    const t = io({}, {}, 409, {
      error: '1.4.0 is live in production, so publish a version higher than 1.4.0.',
    });
    expect(await run(['release', '1.3.0'], t.io)).toBe(1);
    expect(t.lines[0]).toBe(
      'OpenVersion said: 1.4.0 is live in production, so publish a version higher than 1.4.0.',
    );
  });

  it('needs the URL and the token', async () => {
    const t = io({ OPENVERSION_TOKEN: '' });
    expect(await run(['status'], t.io)).toBe(1);
    expect(t.lines[0]).toContain('OPENVERSION_TOKEN');
    const flags = io({ OPENVERSION_URL: '', OPENVERSION_TOKEN: '' }, {}, 200, null);
    expect(await run(['status', '--url', 'https://x.test', '--token', 'ov_test_x'], flags.io)).toBe(
      0,
    );
    expect(flags.lines[0]).toBe('Nothing is released in this environment yet.');
  });
});

describe('openversion refresh and status', () => {
  it('sends a hard refresh', async () => {
    const t = io({}, {}, 200, { epoch: 4 });
    expect(await run(['refresh'], t.io)).toBe(0);
    expect(t.sent().url).toBe('https://version.test/api/v1/refresh');
    expect(t.lines[0]).toContain('epoch 4');
  });

  it('UC-8/S2 says when open tabs reload, as the dashboard does', async () => {
    const t = io({}, {}, 200, { epoch: 4 });
    await run(['refresh'], t.io);
    expect(t.lines[0]).toContain(HARD_REFRESH_TIMING);
    expect(t.lines[0]).toContain('Background tabs reload when they are shown again');
  });

  it('shows the live release', async () => {
    const t = io({}, {}, 200, { ...RELEASE, hard: true });
    expect(await run(['status'], t.io)).toBe(0);
    expect(t.lines[0]).toMatch(/^Shop production: 1\.5\.0 \(hard/);
  });
});

describe('notesFor', () => {
  it('takes the Unreleased section when there is none for the version', () => {
    expect(notesFor('## Unreleased\n\n- New\n\n## 1.0.0\n\n- Old', null)).toBe('- New');
  });

  it('takes the whole file when it has no sections', () => {
    expect(notesFor('Just text.\n', '1.0.0')).toBe('Just text.');
  });

  it('matches v-prefixed headings and stops at the next one', () => {
    expect(notesFor('## v1.2.0\n### Fixed\n- A\n## v1.1.0\n- B', '1.2.0')).toBe('### Fixed\n- A');
  });
});
