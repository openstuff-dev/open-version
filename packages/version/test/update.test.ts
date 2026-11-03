// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Environment, resetConfig, configure } from '../src/core/client.js';
import type { VersionInfo } from '../src/core/types.js';
import '../src/update/index.js';

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function env(live: VersionInfo, reload = vi.fn()): Environment {
  return {
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(live), { status: 200 }),
      ),
    window,
    document,
    reload,
    session: memory(),
    local: memory(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => {
      clearTimeout(id as number);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => {
      clearInterval(id as number);
    },
    now: () => Date.now(),
  };
}

const live = (over: Partial<VersionInfo>): VersionInfo => ({
  version: '1.5.0',
  hard: false,
  epoch: 1,
  policy: 'prompt',
  releasedAt: null,
  notesUrl: 'https://version.test/notes/r1',
  ...over,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('<ov-update>', () => {
  afterEach(() => {
    resetConfig();
    document.body.replaceChildren();
  });

  it('shows the toast with Reload and What’s new, and closes until the next version', async () => {
    const reload = vi.fn();
    const element = document.createElement('ov-update');
    document.body.append(element);
    const client = configure(
      { url: 'https://version.test', publicKey: 'pk_t', version: '1.4.0' },
      env(live({}), reload),
    );
    await client.check();
    await settle();
    const root = element.shadowRoot;
    const toast = root?.querySelector<HTMLElement>('[part="toast"]');
    expect(toast?.hidden).toBe(false);
    expect(toast?.textContent).toContain('A new version is ready.');
    expect(root?.querySelector('[part~="notes"]')?.getAttribute('href')).toBe(
      'https://version.test/notes/r1',
    );
    root?.querySelector<HTMLButtonElement>('[part~="reload"]')?.click();
    expect(reload).toHaveBeenCalledTimes(1);
    root?.querySelector<HTMLButtonElement>('[part="close"]')?.click();
    expect(toast?.hidden).toBe(true);
  });

  it('shows the countdown banner for a hard release', async () => {
    const reload = vi.fn();
    const element = document.createElement('ov-update');
    element.setAttribute('forced-message', 'Reloading in {s}.');
    document.body.append(element);
    const client = configure(
      { url: 'https://version.test', publicKey: 'pk_t', version: '1.4.0' },
      env(live({ hard: true }), reload),
    );
    await client.check();
    await settle();
    const banner = element.shadowRoot?.querySelector<HTMLElement>('[part="banner"]');
    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent).toMatch(/^Reloading in 30 s\.Reload now$/);
    banner?.querySelector<HTMLButtonElement>('button')?.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows nothing while the version is current', async () => {
    const element = document.createElement('ov-update');
    document.body.append(element);
    const client = configure(
      { url: 'https://version.test', publicKey: 'pk_t', version: '1.5.0' },
      env(live({})),
    );
    await client.check();
    await settle();
    expect(element.shadowRoot?.querySelector<HTMLElement>('[part="toast"]')?.hidden).toBe(true);
    expect(element.shadowRoot?.querySelector<HTMLElement>('[part="banner"]')?.hidden).toBe(true);
  });
});
