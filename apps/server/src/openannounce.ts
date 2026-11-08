import { type FetchPolicy, FetchRefused, safeFetch, type SafeResponse } from '@openstuff-dev/server';

/** A failure worth trying again (network, 5xx, 429) or not (a refused key, a bad group). */
export class PostError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

function serverSays(response: SafeResponse): string {
  try {
    const error = (JSON.parse(response.body) as { error?: unknown }).error;
    if (typeof error === 'string' && error) return error;
  } catch {
    // Not JSON: fall back to the status.
  }
  return `it answered ${response.status}`;
}

async function call(
  policy: FetchPolicy,
  base: string,
  path: string,
  key: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string } = {},
): Promise<SafeResponse> {
  try {
    return await safeFetch(`${base.replace(/\/$/, '')}${path}`, policy, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'user-agent': 'OpenVersion',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    if (err instanceof FetchRefused) throw new PostError(err.message, false);
    throw new PostError(`Couldn’t reach ${base}: ${(err as Error).message}`, true);
  }
}

/** Checks a URL and publish key against OpenAnnounce, without posting. Says what it found. */
export async function testOpenAnnounce(
  policy: FetchPolicy,
  url: string,
  key: string,
): Promise<string> {
  const response = await call(policy, url, '/api/v1/publish-key', key);
  if (response.status === 401) {
    throw new PostError('OpenAnnounce refused the publish key. Make a new one on the system’s page in OpenAnnounce.', false);
  }
  if (response.status === 404) {
    throw new PostError(`${url} doesn’t look like an OpenAnnounce with the publish API. Check the URL, and that OpenAnnounce is up to date.`, false);
  }
  if (response.status !== 200) throw new PostError(`OpenAnnounce said: ${serverSays(response)}`, false);
  interface Found {
    tenant?: { name?: string };
    system?: { name?: string };
  }
  const found = JSON.parse(response.body) as Found;
  return `Connected. Release notes go to ${found.system?.name ?? 'the system'} in ${found.tenant?.name ?? 'OpenAnnounce'}.`;
}

export interface ReleasePost {
  releaseId: string;
  app: string;
  version: string;
  notes: string;
  groups: string[];
}

/**
 * Posts a release's notes as News. The release id is the Idempotency-Key, so however often a
 * post is retried, OpenAnnounce shows it once.
 */
export async function postToOpenAnnounce(
  policy: FetchPolicy,
  url: string,
  key: string,
  release: ReleasePost,
): Promise<void> {
  const response = await call(policy, url, '/api/v1/messages', key, {
    method: 'POST',
    idempotencyKey: `openversion-release-${release.releaseId}`,
    body: {
      title: `${release.app} ${release.version}`.slice(0, 200),
      body: release.notes.slice(0, 10_000),
      ...(release.groups.length ? { groups: release.groups } : {}),
    },
  });
  if (response.status === 200 || response.status === 201) return;
  const reason = serverSays(response);
  // Server trouble and rate limits pass; a refused key or unknown group needs a person.
  const retry = response.status >= 500 || response.status === 429 || response.status === 408;
  throw new PostError(
    response.status === 401 ? 'OpenAnnounce refused the publish key.' : `OpenAnnounce said: ${reason}`,
    retry,
  );
}

/**
 * Checks a public key and origin against OpenAnnounce's feed, without changing anything. The
 * feed answers 401 for an unknown key and 403 for an origin the system doesn't allow, so the
 * answer says what to change.
 */
export async function checkOpenAnnounceFeed(
  policy: FetchPolicy,
  url: string,
  publicKey: string,
  origin: string,
): Promise<string> {
  let response: SafeResponse;
  try {
    response = await safeFetch(`${url.replace(/\/$/, '')}/api/v1/feed`, policy, {
      headers: {
        'x-openannounce-key': publicKey,
        origin,
        accept: 'application/json',
        'user-agent': 'OpenVersion',
      },
    });
  } catch (err) {
    if (err instanceof FetchRefused) throw new PostError(err.message, false);
    throw new PostError('That address didn’t answer. Check the URL and that OpenAnnounce is running.', true);
  }
  if (response.status === 200) return 'Connected to OpenAnnounce.';
  if (response.status === 401) {
    throw new PostError(`OpenAnnounce doesn’t recognise this public key: ${serverSays(response)}`, false);
  }
  if (response.status === 403) {
    throw new PostError(
      `Add ${origin} to allowed origins in OpenAnnounce, on the system’s page, then test again.`,
      false,
    );
  }
  if (response.status === 404) {
    throw new PostError(`${url} doesn’t look like an OpenAnnounce with the feed API. Check the URL.`, false);
  }
  throw new PostError(`OpenAnnounce said: ${serverSays(response)}`, response.status >= 500);
}
