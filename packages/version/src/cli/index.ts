#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { type Bump, isVersion } from '../core/semver.js';

const HELP = `openversion: publish releases and refresh open tabs from CI.

Usage:
  openversion release [1.4.2 | --patch | --minor | --major | --from-package]
                      [--notes-file CHANGELOG.md | --notes "text"] [--hard]
  openversion refresh     Every open tab reloads once (hard refresh)
  openversion status      Shows the live release

Settings (environment variables, or the flags):
  OPENVERSION_URL     --url     Where OpenVersion runs, e.g. https://version.example.com
  OPENVERSION_TOKEN   --token   The environment's deploy token, ov_live_… (keep it in a CI secret)

With no version or bump, release publishes the next patch version.
For notes that start with a dash, use --notes="- Fixed …".
An Idempotency-Key is sent from GITHUB_SHA (or CI_COMMIT_SHA and the like), so a retried job
publishes once.`;

/** An error to show as is, then exit 1. */
export class CliError extends Error {}

export interface Io {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  readFile: (path: string) => Promise<string>;
  out: (line: string) => void;
  /** Where errors go. Default: like `out`. */
  err?: (line: string) => void;
}

const SHA_VARIABLES = [
  'GITHUB_SHA',
  'CI_COMMIT_SHA',
  'BITBUCKET_COMMIT',
  'CIRCLE_SHA1',
  'BUILD_SOURCEVERSION',
  'GIT_COMMIT',
];

/**
 * The part of a changelog for `version`: from its heading (`## 1.4.2`, `## [1.4.2] - date`,
 * `## v1.4.2`) to the next heading of the same level. Without one, the "Unreleased" section,
 * else the whole file.
 */
export function notesFor(changelog: string, version: string | null): string {
  const lines = changelog.split(/\r?\n/);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const find = (pattern: RegExp) => {
    const start = lines.findIndex((l) => pattern.test(l));
    if (start < 0) return null;
    const level = /^#+/.exec(lines[start])?.[0].length ?? 2;
    const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
    return lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join('\n')
      .trim();
  };
  const section =
    (version ? find(new RegExp(`^#{1,3}\\s+\\[?v?${escape(version)}\\]?(\\s|$)`)) : null) ??
    find(/^#{1,3}\s+\[?unreleased\]?/i);
  return (section ?? changelog.trim()).slice(0, 20_000);
}

interface Release {
  id: string;
  version: string;
  hard: boolean;
  notes: string;
  createdAt: string;
  app: string;
  environment: string;
}

async function call<T>(
  io: Io,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<T> {
  const url = (io.env.OPENVERSION_URL ?? '').replace(/\/$/, '');
  const token = io.env.OPENVERSION_TOKEN ?? '';
  if (!url)
    throw new CliError(
      'Set OPENVERSION_URL to where OpenVersion runs, e.g. https://version.example.com.',
    );
  if (!token)
    throw new CliError(
      'Set OPENVERSION_TOKEN to the environment’s deploy token (ov_live_…). Keep it in a CI secret.',
    );
  let response: Response;
  try {
    response = await io.fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'openversion-cli/1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError(`Couldn’t reach ${url}: ${(err as Error).message}`);
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message =
      (data as { error?: string } | null)?.error ?? `${response.status} ${response.statusText}`;
    throw new CliError(`OpenVersion said: ${message}`);
  }
  return data as T;
}

const describe = (r: Release) =>
  `${r.app} ${r.environment}: ${r.version}${r.hard ? ' (hard: open tabs reload)' : ''}, published ${r.createdAt}`;

/** Runs the CLI with `argv` (without node and the script). Returns the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        patch: { type: 'boolean' },
        minor: { type: 'boolean' },
        major: { type: 'boolean' },
        'from-package': { type: 'boolean' },
        'notes-file': { type: 'string' },
        notes: { type: 'string' },
        hard: { type: 'boolean' },
        url: { type: 'string' },
        token: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    (io.err ?? io.out)(`${(err as Error).message}\n\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.out(HELP);
    return values.help ? 0 : 1;
  }
  const env = { ...io.env };
  if (values.url) env.OPENVERSION_URL = values.url;
  if (values.token) env.OPENVERSION_TOKEN = values.token;
  const ctx = { ...io, env };

  try {
    if (command === 'status') {
      const live = await call<Release | null>(ctx, 'GET', '/api/v1/releases/live');
      io.out(live ? describe(live) : 'Nothing is released in this environment yet.');
      return 0;
    }
    if (command === 'refresh') {
      const { epoch } = await call<{ epoch: number }>(ctx, 'POST', '/api/v1/refresh', {});
      io.out(`Hard refresh sent (epoch ${epoch}). Every open tab reloads within a few minutes.`);
      return 0;
    }
    if (command !== 'release')
      throw new CliError(`Unknown command "${command}". Use release, refresh or status.`);

    const bumps = (['patch', 'minor', 'major'] as const).filter((b) => values[b]);
    let version = rest.at(0) ?? null;
    if (values['from-package']) {
      const pkg = JSON.parse(await io.readFile('package.json')) as { version?: string };
      if (!pkg.version) throw new CliError('package.json has no version.');
      version = pkg.version;
    }
    if (rest.length > 1 || bumps.length > 1 || (version && bumps.length)) {
      throw new CliError('Give one version or one of --patch, --minor, --major.');
    }
    if (version && !isVersion(version))
      throw new CliError(`"${version}" isn’t a version like 1.4.2.`);
    if (values.notes && values['notes-file'])
      throw new CliError('Use --notes or --notes-file, not both.');
    let notes = values.notes;
    if (values['notes-file']) {
      let file: string;
      try {
        file = await io.readFile(values['notes-file']);
      } catch {
        throw new CliError(`Couldn’t read ${values['notes-file']}.`);
      }
      notes = notesFor(file, version?.replace(/^v/, '') ?? null);
    }
    const body = {
      ...(version ? { version } : { bump: (bumps.at(0) ?? 'patch') satisfies Bump }),
      ...(notes ? { notes } : {}),
      ...(values.hard ? { hard: true } : {}),
    };
    const sha = SHA_VARIABLES.map((name) => env[name]).find(Boolean);
    const headers: Record<string, string> = sha ? { 'idempotency-key': `release-${sha}` } : {};
    const release = await call<Release>(ctx, 'POST', '/api/v1/releases', body, headers);
    io.out(`Published ${describe(release)}`);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      (io.err ?? io.out)(err.message);
      return 1;
    }
    throw err;
  }
}

/** True when this file is the program, not an import (tests import it). */
const isMain = process.argv[1] && /openversion$|cli[\\/]index\.js$/.test(process.argv[1]);
if (isMain) {
  const code = await run(process.argv.slice(2), {
    env: process.env,
    fetch: (...args) => globalThis.fetch(...args),
    readFile: (path) => readFile(path, 'utf8'),
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
  process.exitCode = code;
}
