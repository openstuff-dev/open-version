import { describe, expect, it } from 'vitest';
import { bump, compareVersions, decide, type LiveState, parseVersion } from '../src/index.js';

const live = (over: Partial<LiveState> = {}): LiveState => ({
  version: '1.4.2',
  hard: false,
  epoch: 3,
  policy: 'prompt',
  ...over,
});

describe('decide', () => {
  it.each([
    ['same version, same epoch', '1.4.2', 3, live(), 'none'],
    ['nothing released yet', '1.0.0', 3, live({ version: null }), 'none'],
    ['newer release', '1.4.1', 3, live(), 'prompt'],
    ['newer hard release', '1.4.1', 3, live({ hard: true }), 'force'],
    ['newer release, policy force', '1.4.1', 3, live({ policy: 'force' }), 'force'],
    ['epoch raised, same version', '1.4.2', 2, live(), 'force'],
    ['epoch raised, newer version', '1.4.1', 2, live(), 'force'],
    ['epoch lower than seen (a stale answer)', '1.4.2', 4, live(), 'none'],
    ['first check: no epoch seen yet', '1.4.2', null, live({ epoch: 9 }), 'none'],
    ['first check with a newer version', '1.4.1', null, live({ epoch: 9 }), 'prompt'],
    // A rollback makes an older release live: "different from live" counts, not "lower".
    ['rollback to a lower version', '1.5.0', 3, live(), 'prompt'],
    ['hard rollback to a lower version', '1.5.0', 3, live({ hard: true }), 'force'],
    ['hard release the tab already runs', '1.4.2', 3, live({ hard: true }), 'none'],
    ['same version with a v prefix', 'v1.4.2', 3, live(), 'none'],
    ['same version, other build metadata', '1.4.2+abc', 3, live(), 'none'],
    ['pre-release to its release', '1.5.0-rc.1', 3, live({ version: '1.5.0' }), 'prompt'],
    ['next pre-release', '1.5.0-rc.1', 3, live({ version: '1.5.0-rc.2' }), 'prompt'],
  ] as const)('%s', (_name, running, seen, state, expected) => {
    expect(decide(running, seen, state)).toBe(expected);
  });
});

describe('parseVersion', () => {
  it('reads releases, pre-releases, build metadata and a v prefix', () => {
    expect(parseVersion('1.4.2')).toEqual({ major: 1, minor: 4, patch: 2, prerelease: [], build: [] });
    expect(parseVersion('v1.5.0-rc.1+sha.7')).toEqual({
      major: 1,
      minor: 5,
      patch: 0,
      prerelease: ['rc', 1],
      build: ['sha', '7'],
    });
  });

  it.each(['1.4', '1.4.2.1', '01.2.3', '1.2.3-', '1.2.3-01', 'latest', ''])('refuses %j', (text) => {
    expect(parseVersion(text)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('sorts by semver precedence', () => {
    const sorted = [
      '1.5.0',
      '1.0.0',
      '1.5.0-rc.10',
      '1.5.0-rc.2',
      '1.5.0-beta',
      '1.5.0-rc.1',
      '1.10.0',
      '1.5.0-1',
      '2.0.0',
    ].sort(compareVersions);
    expect(sorted).toEqual([
      '1.0.0',
      '1.5.0-1',
      '1.5.0-beta',
      '1.5.0-rc.1',
      '1.5.0-rc.2',
      '1.5.0-rc.10',
      '1.5.0',
      '1.10.0',
      '2.0.0',
    ]);
  });

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });
});

describe('bump', () => {
  it.each([
    ['1.4.2', 'patch', '1.4.3'],
    ['1.4.2', 'minor', '1.5.0'],
    ['1.4.2', 'major', '2.0.0'],
    ['1.5.0-rc.1', 'patch', '1.5.0'],
    ['1.5.0-rc.1', 'minor', '1.5.0'],
    ['1.5.0-rc.1', 'major', '2.0.0'],
    ['2.0.0-rc.1', 'major', '2.0.0'],
    ['1.5.1-rc.1', 'minor', '1.6.0'],
    ['v0.9.9+build', 'patch', '0.9.10'],
  ] as const)('%s + %s = %s', (from, part, to) => {
    expect(bump(from, part)).toBe(to);
  });

  it('refuses text that is not a version', () => {
    expect(() => bump('latest', 'patch')).toThrow(/isn't a version/);
  });
});
