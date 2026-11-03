/** A semantic version, `1.4.2` or `1.5.0-rc.1+build.7`, split into its parts. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** The pre-release identifiers: `1.5.0-rc.1` → `['rc', 1]`. Empty for a release. */
  prerelease: (string | number)[];
  /** Build metadata after `+`. Ignored when comparing. */
  build: string[];
}

export type Bump = 'major' | 'minor' | 'patch';

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Parses `1.4.2`, `v1.4.2` or `1.5.0-rc.1`. Returns null for anything else. */
export function parseVersion(text: string): Version | null {
  const match = SEMVER.exec(text.trim());
  if (!match) return null;
  const [, major, minor, patch, pre, build] = match;
  const numbers = [major, minor, patch].map(Number);
  if (numbers.some((n) => !Number.isSafeInteger(n))) return null;
  return {
    major: numbers[0],
    minor: numbers[1],
    patch: numbers[2],
    prerelease: pre ? pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
    build: build ? build.split('.') : [],
  };
}

/** True for a version `parseVersion` accepts. */
export function isVersion(text: string): boolean {
  return parseVersion(text) !== null;
}

/** The version as text, without a leading `v`. */
export function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  const pre = version.prerelease.length ? `-${version.prerelease.join('.')}` : '';
  const build = version.build.length ? `+${version.build.join('.')}` : '';
  return core + pre + build;
}

/**
 * Semver precedence: negative when `a` comes before `b`, 0 when equal, positive after.
 * `1.5.0-rc.1` < `1.5.0-rc.2` < `1.5.0`. Build metadata doesn't count.
 * Text that isn't a version compares as text, after every real version.
 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) {
    if (va) return -1;
    if (vb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (va[key] !== vb[key]) return va[key] - vb[key];
  }
  const pa = va.prerelease;
  const pb = vb.prerelease;
  // A pre-release comes before the release itself.
  if (!pa.length || !pb.length) return pb.length - pa.length;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    // Numbers come before words; numbers compare as numbers, words as ASCII.
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** True when both are the same version (build metadata aside). */
export function sameVersion(a: string, b: string): boolean {
  return compareVersions(a, b) === 0;
}

/**
 * The next version, as `npm version` makes it. A pre-release becomes its own release first:
 * `bump('1.5.0-rc.1', 'minor')` is `1.5.0`, and `bump('1.4.2', 'minor')` is `1.5.0`.
 */
export function bump(version: string, part: Bump): string {
  const v = parseVersion(version);
  if (!v) throw new Error(`"${version}" isn't a version like 1.4.2.`);
  const pre = v.prerelease.length > 0;
  let next: Version;
  if (part === 'major') {
    next = pre && v.minor === 0 && v.patch === 0
      ? { ...v, prerelease: [], build: [] }
      : { major: v.major + 1, minor: 0, patch: 0, prerelease: [], build: [] };
  } else if (part === 'minor') {
    next = pre && v.patch === 0
      ? { ...v, prerelease: [], build: [] }
      : { major: v.major, minor: v.minor + 1, patch: 0, prerelease: [], build: [] };
  } else {
    next = pre
      ? { ...v, prerelease: [], build: [] }
      : { major: v.major, minor: v.minor, patch: v.patch + 1, prerelease: [], build: [] };
  }
  return formatVersion(next);
}
