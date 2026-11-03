import { type Decision, decide } from './decide.js';
import type { VersionInfo } from './types.js';

/** What `configure` takes. */
export interface OpenVersionConfig {
  /** Where OpenVersion runs, e.g. https://version.example.com. */
  url: string;
  /** The environment's public key (pk_…). It's safe in the browser. */
  publicKey: string;
  /** The version this build is, set at build time, e.g. `import.meta.env.VITE_APP_VERSION`. */
  version: string;
  /** Seconds between checks while the tab is visible. 0 turns the timer off. Default 300. */
  interval?: number;
  /** Seconds the "reloading" banner counts down before a forced reload. Default 30. */
  countdown?: number;
}

/** What the client needs from the browser. Tests pass fakes; the defaults are the real ones. */
export interface Environment {
  fetch: typeof fetch;
  /** Where `online`, `popstate`, `vite:preloadError` and the like arrive. */
  window: Pick<EventTarget, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;
  document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & {
    visibilityState: DocumentVisibilityState;
  };
  /** The Navigation API, where the browser has it. */
  navigation?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  reload: () => void;
  /** Remembers what this tab already reloaded for. Default `sessionStorage`. */
  session: Pick<Storage, 'getItem' | 'setItem'>;
  /** Remembers which version people closed the toast for. Default `localStorage`. */
  local: Pick<Storage, 'getItem' | 'setItem'>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  now: () => number;
}

/** What the client knows now. */
export interface UpdateState {
  decision: Decision;
  /** The last answer from the server, if any. */
  live: VersionInfo | null;
  /** The version this tab runs. */
  running: string;
  /** For `force`: when the tab reloads unless something else reloads it first (ms epoch). */
  reloadAt: number | null;
  /** For `prompt`: people closed the toast for this version. */
  dismissed: boolean;
}

export interface UpdateEventDetail {
  live: VersionInfo;
  running: string;
}

export interface ForcedEventDetail extends UpdateEventDetail {
  reloadAt: number;
}

declare global {
  interface WindowEventMap {
    'ov-update-available': CustomEvent<UpdateEventDetail>;
    'ov-update-forced': CustomEvent<ForcedEventDetail>;
  }
}

const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
};

function storage(kind: 'sessionStorage' | 'localStorage'): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    const store = globalThis[kind];
    store.getItem('openversion');
    return store;
  } catch {
    // Private mode or a sandboxed frame: keep it in memory for this page.
    return memory();
  }
}

/** The real browser. Only called when a client is made, so importing this file is safe in Node. */
export function browserEnvironment(): Environment {
  const g = globalThis as typeof globalThis & { navigation?: EventTarget };
  return {
    fetch: (...args) => globalThis.fetch(...args),
    window: globalThis,
    document: globalThis.document,
    navigation: g.navigation,
    reload: () => {
      globalThis.location.reload();
    },
    session: storage('sessionStorage'),
    local: storage('localStorage'),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => {
      globalThis.clearTimeout(id as number);
    },
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => {
      globalThis.clearInterval(id as number);
    },
    now: () => Date.now(),
  };
}

/** Messages browsers and bundlers use when a lazy chunk from an older build is gone. */
const CHUNK_ERROR =
  /ChunkLoadError|Loading chunk [\w-]+ failed|Loading CSS chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** True when an error looks like a stale chunk: the tab runs an old build whose files are gone. */
export function isChunkError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: unknown; message?: unknown };
  const text = `${typeof e.name === 'string' ? e.name : ''} ${typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : ''}`;
  return CHUNK_ERROR.test(text);
}

type Listener = (state: UpdateState) => void;

/**
 * Checks whether a newer (or rolled-back) version is live and tells the page.
 *
 * - Checks on start, when the tab becomes visible, when it comes back online, and every
 *   `interval` seconds while visible. One request at a time, with `If-None-Match`.
 * - `prompt`: fires `ov-update-available`; `<ov-update>` shows a toast.
 * - `force`: fires `ov-update-forced` (cancelable) and reloads at the next safe moment: when
 *   the tab is hidden, on the next navigation, or after `countdown` seconds.
 * - Never reloads twice for the same version or epoch in a tab, so a bad deploy can't loop.
 * - On a stale chunk error it checks at once and reloads if the version changed.
 */
export class VersionClient {
  private state: UpdateState;
  private etag: string | null = null;
  private seenEpoch: number | null = null;
  private inFlight: Promise<UpdateState> | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly cleanups: (() => void)[] = [];
  private countdownTimer: unknown;
  private forcedFor: string | null = null;
  private started = false;

  constructor(
    readonly config: OpenVersionConfig,
    private readonly env: Environment = browserEnvironment(),
  ) {
    this.state = {
      decision: 'none',
      live: null,
      running: config.version,
      reloadAt: null,
      dismissed: false,
    };
  }

  get current(): UpdateState {
    return this.state;
  }

  /** Calls `listener` now and after every change. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Starts checking: now, on visibility, online, navigation and stale chunks, and on a timer. */
  start(): this {
    if (this.started) return this;
    this.started = true;
    const on = (
      target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | undefined,
      type: string,
      fn: (e: Event) => void,
    ) => {
      if (!target) return;
      target.addEventListener(type, fn);
      this.cleanups.push(() => {
        target.removeEventListener(type, fn);
      });
    };
    const { window, document, navigation } = this.env;
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.reloadIfForced();
      else void this.check();
    });
    on(window, 'online', () => void this.check());
    // A navigation is a safe moment: the page the person asked for loads fresh.
    on(window, 'popstate', () => {
      this.reloadIfForced();
    });
    on(navigation, 'navigatesuccess', () => {
      this.reloadIfForced();
    });
    on(window, 'vite:preloadError', () => void this.onChunkError());
    on(window, 'error', (e) => {
      if (isChunkError((e as ErrorEvent).error ?? (e as ErrorEvent).message))
        void this.onChunkError();
    });
    on(window, 'unhandledrejection', (e) => {
      if (isChunkError((e as PromiseRejectionEvent).reason)) void this.onChunkError();
    });
    const seconds = this.config.interval ?? 300;
    if (seconds > 0) {
      const timer = this.env.setInterval(() => {
        if (document.visibilityState !== 'hidden') void this.check();
      }, seconds * 1000);
      this.cleanups.push(() => {
        this.env.clearInterval(timer);
      });
    }
    void this.check();
    return this;
  }

  /** Stops every listener and timer. */
  stop(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.env.clearTimeout(this.countdownTimer);
    this.started = false;
  }

  /** Asks the server now. Calls at the same time share one request. Never throws. */
  check(): Promise<UpdateState> {
    this.inFlight ??= this.fetchLive().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Reloads now (the toast's Reload button). */
  reload(): void {
    const live = this.state.live;
    if (live) this.env.session.setItem(this.guardKey(), this.target(live));
    this.env.reload();
  }

  /** Hides the toast until the next version. */
  dismiss(): void {
    const live = this.state.live;
    if (!live?.version) return;
    this.env.local.setItem(this.dismissKey(), live.version);
    this.update({ ...this.state, dismissed: true });
  }

  private async fetchLive(): Promise<UpdateState> {
    const headers: Record<string, string> = {};
    if (this.etag) headers['If-None-Match'] = this.etag;
    const base = this.config.url.replace(/\/$/, '');
    let live = this.state.live;
    try {
      const response = await this.env.fetch(
        `${base}/api/v1/version?key=${encodeURIComponent(this.config.publicKey)}`,
        {
          headers,
          cache: 'no-store',
          credentials: 'omit',
        },
      );
      if (response.status === 200) {
        live = (await response.json()) as VersionInfo;
        this.etag = response.headers.get('ETag');
      } else if (response.status !== 304) {
        return this.state;
      }
    } catch {
      // Offline or blocked: try again on the next check.
      return this.state;
    }
    if (!live) return this.state;
    // The first answer sets the epoch this tab started at.
    this.seenEpoch ??= live.epoch;
    this.apply(live);
    return this.state;
  }

  private apply(live: VersionInfo): void {
    let decision = decide(this.config.version, this.seenEpoch, live);
    const target = this.target(live);
    // Already reloaded for this once and still not there (an old build cached somewhere): ask
    // instead of reloading again, so a bad deploy can never loop.
    if (decision === 'force' && this.env.session.getItem(this.guardKey()) === target)
      decision = 'prompt';
    const dismissed =
      decision === 'prompt' &&
      live.version !== null &&
      this.env.local.getItem(this.dismissKey()) === live.version;
    const previous = this.state;
    if (decision !== 'force') this.cancelCountdown();
    this.update({
      decision,
      live,
      running: this.config.version,
      reloadAt: decision === 'force' ? previous.reloadAt : null,
      dismissed,
    });

    const detail = { live, running: this.config.version };
    if (
      decision === 'prompt' &&
      (previous.decision !== 'prompt' || previous.live?.version !== live.version)
    ) {
      this.env.window.dispatchEvent(new CustomEvent('ov-update-available', { detail }));
    }
    if (decision === 'force' && this.forcedFor !== target) {
      this.forcedFor = target;
      this.startCountdown(live, target);
    }
  }

  private startCountdown(live: VersionInfo, target: string): void {
    const seconds = this.config.countdown ?? 30;
    const reloadAt = this.env.now() + seconds * 1000;
    const event = new CustomEvent('ov-update-forced', {
      detail: { live, running: this.config.version, reloadAt },
      cancelable: true,
    });
    // An app that handles the reload itself calls preventDefault().
    if (!this.env.window.dispatchEvent(event)) return;
    this.update({ ...this.state, reloadAt });
    if (this.env.document.visibilityState === 'hidden') {
      this.forceReload(target);
      return;
    }
    this.env.clearTimeout(this.countdownTimer);
    this.countdownTimer = this.env.setTimeout(() => {
      this.forceReload(target);
    }, seconds * 1000);
  }

  private cancelCountdown(): void {
    this.env.clearTimeout(this.countdownTimer);
    this.countdownTimer = undefined;
    this.forcedFor = null;
  }

  private reloadIfForced(): void {
    if (this.state.decision === 'force' && this.state.reloadAt !== null && this.state.live) {
      this.forceReload(this.target(this.state.live));
    }
  }

  private forceReload(target: string): void {
    if (this.env.session.getItem(this.guardKey()) === target) return;
    this.env.session.setItem(this.guardKey(), target);
    this.env.clearTimeout(this.countdownTimer);
    this.env.reload();
  }

  private async onChunkError(): Promise<void> {
    const state = await this.check();
    if (state.decision !== 'none' && state.live) this.forceReload(this.target(state.live));
  }

  /** What a reload is for: the live version and epoch together. */
  private target(live: VersionInfo): string {
    return `${live.version ?? ''}|${live.epoch}`;
  }

  private guardKey(): string {
    return `openversion:reloaded:${this.config.publicKey}`;
  }

  private dismissKey(): string {
    return `openversion:dismissed:${this.config.publicKey}`;
  }

  private update(state: UpdateState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

let current: VersionClient | undefined;
const waiting: ((client: VersionClient) => void)[] = [];

/**
 * Starts checking for new versions. Call it once, early, in the browser. `<ov-update>` and
 * `whenConfigured()` use this client.
 */
export function configure(config: OpenVersionConfig, env?: Environment): VersionClient {
  current?.stop();
  current = new VersionClient(config, env).start();
  for (const resolve of waiting.splice(0)) resolve(current);
  return current;
}

/** The client from `configure`, once it's been called. */
export function whenConfigured(): Promise<VersionClient> {
  return current ? Promise.resolve(current) : new Promise((resolve) => waiting.push(resolve));
}

/** For tests. */
export function resetConfig(): void {
  current?.stop();
  current = undefined;
}
