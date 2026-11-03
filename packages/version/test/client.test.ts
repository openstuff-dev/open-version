import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Environment, isChunkError, VersionClient } from '../src/core/client.js';
import type { VersionInfo } from '../src/core/types.js';

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const info = (over: Partial<VersionInfo> = {}): VersionInfo => ({
  version: '1.4.0',
  hard: false,
  epoch: 1,
  policy: 'prompt',
  releasedAt: '2026-11-01T10:00:00.000Z',
  notesUrl: null,
  ...over,
});

/** A fake server: `live` is what it answers; it does ETags like the real one. */
function fakeBrowser(session = memory()) {
  let live = info();
  let down = false;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  });
  const navigation = new EventTarget();
  const reload = vi.fn();
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    if (down) return Promise.reject(new TypeError('Failed to fetch'));
    const etag = `"${JSON.stringify(live)}"`;
    if (headers['If-None-Match'] === etag)
      return Promise.resolve(new Response(null, { status: 304 }));
    return Promise.resolve(
      new Response(JSON.stringify(live), { status: 200, headers: { ETag: etag } }),
    );
  }) as unknown as typeof globalThis.fetch;
  const env: Environment = {
    fetch,
    window,
    document,
    navigation,
    reload,
    session,
    local: memory(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => {
      clearTimeout(id as ReturnType<typeof setTimeout>);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => {
      clearInterval(id as ReturnType<typeof setInterval>);
    },
    now: () => Date.now(),
  };
  return {
    env,
    calls,
    reload,
    window,
    document,
    navigation,
    session,
    set: (over: Partial<VersionInfo>) => {
      live = info(over);
    },
    offline: (value: boolean) => {
      down = value;
    },
    hide: () => {
      document.visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    show: () => {
      document.visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

const config = {
  url: 'https://version.test/',
  publicKey: 'pk_test',
  version: '1.4.0',
  interval: 60,
  countdown: 30,
};

describe('VersionClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks on start with the public key, and stays quiet on the same version', async () => {
    const b = fakeBrowser();
    const client = new VersionClient(config, b.env).start();
    const state = await client.check();
    expect(b.calls[0].url).toBe('https://version.test/api/v1/version?key=pk_test');
    expect(state.decision).toBe('none');
    expect(b.calls).toHaveLength(1); // start and check share one request
    client.stop();
  });

  it('sends If-None-Match and keeps the answer on a 304', async () => {
    const b = fakeBrowser();
    const client = new VersionClient(config, b.env).start();
    await client.check();
    await client.check();
    expect(b.calls[1].headers['If-None-Match']).toBeDefined();
    expect(client.current.live?.version).toBe('1.4.0');
    client.stop();
  });

  it('prompts for a newer version and fires ov-update-available once', async () => {
    const b = fakeBrowser();
    const events: unknown[] = [];
    b.window.addEventListener('ov-update-available', (e) => events.push((e as CustomEvent).detail));
    const client = new VersionClient(config, b.env).start();
    await client.check();
    b.set({ version: '1.5.0', notesUrl: 'https://version.test/notes/1' });
    await client.check();
    await client.check();
    expect(client.current.decision).toBe('prompt');
    expect(events).toHaveLength(1);
    expect(b.reload).not.toHaveBeenCalled();
    client.stop();
  });

  it('hides the toast until the next version once closed', async () => {
    const b = fakeBrowser();
    b.set({ version: '1.5.0' });
    const client = new VersionClient(config, b.env).start();
    await client.check();
    client.dismiss();
    expect(client.current.dismissed).toBe(true);
    // A new tab, same browser: still closed for 1.5.0.
    const again = new VersionClient(config, { ...b.env, local: b.env.local });
    await again.check();
    expect(again.current.dismissed).toBe(true);
    b.set({ version: '1.6.0' });
    await again.check();
    expect(again.current).toMatchObject({ decision: 'prompt', dismissed: false });
    client.stop();
  });

  it('checks again when the tab becomes visible, comes online, and on the timer while visible', async () => {
    const b = fakeBrowser();
    const client = new VersionClient(config, b.env).start();
    await vi.advanceTimersByTimeAsync(0);
    b.window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    b.hide();
    b.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.calls).toHaveLength(4);
    b.document.visibilityState = 'hidden';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.calls).toHaveLength(4);
    client.stop();
  });

  it('tries again after Retry-After when it is rate-limited', async () => {
    const b = fakeBrowser();
    let limited = true;
    const real = b.env.fetch;
    b.env.fetch = ((url: string, init?: RequestInit) =>
      limited
        ? Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '20' } }))
        : real(url, init)) as typeof fetch;
    b.set({ version: '1.5.0' });
    const client = new VersionClient({ ...config, interval: 0 }, b.env).start();
    await client.check();
    expect(client.current.decision).toBe('none');
    limited = false;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(client.current.decision).toBe('prompt');
    client.stop();
  });

  it('keeps quiet when the server cannot be reached', async () => {
    const b = fakeBrowser();
    b.offline(true);
    const client = new VersionClient(config, b.env).start();
    await expect(client.check()).resolves.toMatchObject({ decision: 'none', live: null });
    client.stop();
  });

  describe('force', () => {
    it('reloads after the countdown for a hard release', async () => {
      const b = fakeBrowser();
      const forced: { reloadAt: number }[] = [];
      b.window.addEventListener('ov-update-forced', (e) => forced.push((e as CustomEvent<{ reloadAt: number }>).detail));
      const client = new VersionClient(config, b.env).start();
      await client.check();
      b.set({ version: '1.5.0', hard: true });
      await client.check();
      expect(client.current.decision).toBe('force');
      expect(forced).toHaveLength(1);
      expect(forced[0].reloadAt).toBe(Date.now() + 30_000);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(b.reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(b.reload).toHaveBeenCalledTimes(1);
      client.stop();
    });

    it('reloads at once when the tab is hidden, or on the next navigation', async () => {
      const hidden = fakeBrowser();
      const a = new VersionClient(config, hidden.env).start();
      await a.check();
      hidden.set({ epoch: 2 });
      await a.check();
      hidden.hide();
      expect(hidden.reload).toHaveBeenCalledTimes(1);
      a.stop();

      const nav = fakeBrowser();
      const b = new VersionClient(config, nav.env).start();
      await b.check();
      nav.set({ epoch: 2 });
      await b.check();
      nav.navigation.dispatchEvent(new Event('navigatesuccess'));
      expect(nav.reload).toHaveBeenCalledTimes(1);
      b.stop();
    });

    it('reloads a hidden tab straight away', async () => {
      const b = fakeBrowser();
      b.document.visibilityState = 'hidden';
      const client = new VersionClient(config, b.env).start();
      await client.check();
      b.set({ version: '1.5.0', policy: 'force' });
      await client.check();
      expect(b.reload).toHaveBeenCalledTimes(1);
      client.stop();
    });

    it('lets the app take over when it cancels ov-update-forced', async () => {
      const b = fakeBrowser();
      b.window.addEventListener('ov-update-forced', (e) => {
        e.preventDefault();
      });
      const client = new VersionClient(config, b.env).start();
      await client.check();
      b.set({ version: '1.5.0', hard: true });
      await client.check();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(b.reload).not.toHaveBeenCalled();
      client.stop();
    });

    it('does not count the first epoch it sees as a hard refresh', async () => {
      const b = fakeBrowser();
      b.set({ epoch: 9 });
      const client = new VersionClient(config, b.env).start();
      await client.check();
      expect(client.current.decision).toBe('none');
      client.stop();
    });

    it('never reloads twice for the same version or epoch, so a stale build cannot loop', async () => {
      const session = memory();
      const b = fakeBrowser(session);
      b.set({ version: '1.5.0', hard: true });
      const first = new VersionClient(config, b.env).start();
      await first.check();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(b.reload).toHaveBeenCalledTimes(1);
      first.stop();

      // After the reload the old build was served again (a cache), so it still runs 1.4.0.
      const second = new VersionClient(config, b.env).start();
      await second.check();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(b.reload).toHaveBeenCalledTimes(1);
      expect(second.current.decision).toBe('prompt');
      second.stop();

      // A newer hard release is a new target, so it reloads once more.
      b.set({ version: '1.5.1', hard: true });
      const third = new VersionClient(config, b.env).start();
      await third.check();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(b.reload).toHaveBeenCalledTimes(2);
      third.stop();
    });

    it('reloads for a rollback to a lower version', async () => {
      const b = fakeBrowser();
      b.set({ version: '1.4.0', hard: true });
      const client = new VersionClient({ ...config, version: '1.5.0' }, b.env).start();
      await client.check();
      expect(client.current.decision).toBe('force');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(b.reload).toHaveBeenCalledTimes(1);
      client.stop();
    });

    it('stops the countdown when the server changes its mind', async () => {
      const b = fakeBrowser();
      const client = new VersionClient(config, b.env).start();
      await client.check();
      b.set({ version: '1.5.0', hard: true });
      await client.check();
      b.set({ version: '1.4.0' });
      await client.check();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(b.reload).not.toHaveBeenCalled();
      client.stop();
    });
  });

  describe('stale chunks', () => {
    it('recognises the errors bundlers throw', () => {
      expect(isChunkError({ name: 'ChunkLoadError', message: 'Loading chunk 42 failed.' })).toBe(
        true,
      );
      expect(
        isChunkError(new TypeError('Failed to fetch dynamically imported module: /assets/a.js')),
      ).toBe(true);
      expect(isChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
      expect(isChunkError(new Error('Cannot read properties of undefined'))).toBe(false);
      expect(isChunkError(null)).toBe(false);
    });

    it('checks at once and reloads when the version changed', async () => {
      const b = fakeBrowser();
      const client = new VersionClient(config, b.env).start();
      await client.check();
      b.set({ version: '1.5.0' });
      b.window.dispatchEvent(new Event('vite:preloadError'));
      await vi.advanceTimersByTimeAsync(0);
      expect(b.reload).toHaveBeenCalledTimes(1);
      client.stop();
    });

    it('does not reload for a chunk error when the version is the same', async () => {
      const b = fakeBrowser();
      const client = new VersionClient(config, b.env).start();
      await client.check();
      const event = Object.assign(new Event('unhandledrejection'), {
        reason: new TypeError('Failed to fetch dynamically imported module: /a.js'),
      });
      b.window.dispatchEvent(event);
      await vi.advanceTimersByTimeAsync(0);
      expect(b.calls).toHaveLength(2);
      expect(b.reload).not.toHaveBeenCalled();
      client.stop();
    });
  });
});
