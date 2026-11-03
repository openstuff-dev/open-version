import {
  type UpdateState,
  type VersionClient,
  whenConfigured,
  VersionClient as Client,
} from '../core/client.js';

export { configure } from '../core/client.js';

/**
 * The default look. Every value is a custom property and every piece a CSS part, so a host
 * restyles it from outside:
 *
 * ```css
 * ov-update { --ov-radius: 4px; --ov-accent: #0a7; }
 * ov-update::part(toast) { inset: auto auto 24px 24px; }
 * ```
 */
const css = `
:host {
  --ov-font: inherit;
  --ov-radius: 8px;
  --ov-bg: light-dark(#ffffff, #1c1c1f);
  --ov-fg: light-dark(#1c1c1f, #ededef);
  --ov-muted: light-dark(#5f5f66, #a1a1aa);
  --ov-border: light-dark(#e4e4e7, #34343a);
  --ov-accent: light-dark(#c2255c, #f06595);
  --ov-accent-fg: #ffffff;
  --ov-banner-bg: light-dark(#fff0f6, #3d1426);
  --ov-shadow: 0 12px 32px rgb(0 0 0 / 0.18);
  --ov-z: 2147483000;
  font-family: var(--ov-font);
  color: var(--ov-fg);
}
:host { display: block; }
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.toast {
  position: fixed;
  inset: auto 16px 16px auto;
  z-index: var(--ov-z);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  max-inline-size: min(420px, calc(100vw - 32px));
  padding: 12px 12px 12px 16px;
  border: 1px solid var(--ov-border);
  border-radius: var(--ov-radius);
  background: var(--ov-bg);
  box-shadow: var(--ov-shadow);
  line-height: 1.45;
  animation: ov-in 200ms cubic-bezier(0.2, 0, 0, 1);
}
.banner {
  position: sticky;
  inset-block-start: 0;
  z-index: var(--ov-z);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px 16px;
  padding: 10px 16px;
  background: var(--ov-banner-bg);
  border-block-end: 1px solid var(--ov-border);
  line-height: 1.45;
  text-align: center;
}
.message { margin: 0; flex: 1 1 12em; min-inline-size: 0; }
.countdown { font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: 8px; align-items: center; }
.button {
  display: inline-flex;
  align-items: center;
  min-block-size: 32px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: calc(var(--ov-radius) - 2px);
  background: var(--ov-accent);
  color: var(--ov-accent-fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
}
.button.secondary { background: transparent; color: inherit; border-color: var(--ov-border); }
.close {
  display: inline-grid;
  place-items: center;
  inline-size: 32px;
  block-size: 32px;
  border: 0;
  border-radius: calc(var(--ov-radius) / 2);
  background: transparent;
  color: var(--ov-muted);
  font: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
@media (hover: hover) {
  .button:hover { filter: brightness(1.08); }
  .close:hover, .button.secondary:hover { background: color-mix(in srgb, currentColor 10%, transparent); filter: none; }
}
.live { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.button:focus-visible, .close:focus-visible { outline: 2px solid var(--ov-accent); outline-offset: 2px; }
@keyframes ov-in { from { opacity: 0; transform: translateY(8px); } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
`;

let sheet: CSSStyleSheet | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

/**
 * `<ov-update>`: tells people a new version is ready.
 *
 * - When the environment asks: a toast, "A new version is ready." with Reload and What's new.
 *   Closing it hides it until the next version.
 * - When the release is hard: a banner, "A new version is live. This page reloads in 30 s."
 *   with Reload now.
 *
 * Uses the client from `configure()`, or its own from the `url`, `public-key` and `version`
 * attributes. Change the words with `message`, `forced-message`, `reload-label`,
 * `notes-label`, `reload-now-label` and `close-label`.
 */
export class OvUpdate extends HTMLElement {
  static observedAttributes = ['url', 'public-key', 'version'];

  private readonly root: ShadowRoot;
  private readonly toast = el('div', { class: 'toast', part: 'toast', hidden: '' });
  private readonly banner = el('div', { class: 'banner', part: 'banner', hidden: '' });
  /**
   * One live region, in the page from the start and empty, so screen readers announce the
   * update when its text changes. The toast and banner themselves aren't live regions.
   */
  private readonly live = el('div', { class: 'live', role: 'status' });

  private client: VersionClient | undefined;
  private own: VersionClient | undefined;
  private unsubscribe: (() => void) | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private connectId = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    sheet ??= new CSSStyleSheet();
    if (!sheet.cssRules.length) sheet.replaceSync(css);
    this.root.adoptedStyleSheets = [sheet];
    this.root.append(this.banner, this.toast, this.live);
  }

  connectedCallback(): void {
    void this.connect();
  }

  disconnectedCallback(): void {
    this.connectId++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.own?.stop();
    this.own = undefined;
    clearInterval(this.tick);
  }

  attributeChangedCallback(): void {
    if (!this.isConnected) return;
    this.disconnectedCallback();
    void this.connect();
  }

  private async connect(): Promise<void> {
    const id = ++this.connectId;
    const url = this.getAttribute('url');
    const publicKey = this.getAttribute('public-key');
    const version = this.getAttribute('version');
    let client: VersionClient;
    if (url && publicKey && version) {
      this.own = new Client({ url, publicKey, version }).start();
      client = this.own;
    } else {
      client = await whenConfigured();
    }
    if (id !== this.connectId) return;
    this.client = client;
    this.unsubscribe = client.subscribe((state) => {
      this.render(state);
    });
  }

  private label(name: string, fallback: string): string {
    return this.getAttribute(name) ?? fallback;
  }

  private render(state: UpdateState): void {
    const showToast = state.decision === 'prompt' && !state.dismissed;
    const showBanner = state.decision === 'force' && state.reloadAt !== null;
    clearInterval(this.tick);
    this.tick = undefined;

    if (showToast && this.toast.hidden) {
      this.toast.replaceChildren(...this.toastContent(state));
      this.announce(this.label('message', 'A new version is ready.'));
    }
    this.toast.hidden = !showToast;

    if (showBanner && this.banner.hidden) {
      const seconds = Math.max(0, Math.ceil(((state.reloadAt ?? 0) - Date.now()) / 1000));
      const sentence = this.label(
        'forced-message',
        'A new version is live. This page reloads in {s}.',
      );
      this.announce(sentence.replace('{s}', `${seconds} seconds`));
    }
    if (showBanner) {
      const reloadAt = state.reloadAt ?? 0;
      const countdown = el('span', { class: 'countdown', part: 'countdown' });
      const update = () => {
        countdown.textContent = `${Math.max(0, Math.ceil((reloadAt - Date.now()) / 1000))} s`;
      };
      update();
      this.tick = setInterval(update, 1000);
      const message = el('p', { class: 'message', part: 'message' });
      const [before, after = ''] = this.label(
        'forced-message',
        'A new version is live. This page reloads in {s}.',
      ).split('{s}');
      // Screen readers hear the sentence once; the seconds tick only on screen.
      countdown.setAttribute('aria-hidden', 'true');
      message.append(before, countdown, after);
      const now = el('button', { class: 'button', part: 'button reload', type: 'button' });
      now.textContent = this.label('reload-now-label', 'Reload now');
      now.addEventListener('click', () => this.client?.reload());
      this.banner.replaceChildren(message, now);
    }
    this.banner.hidden = !showBanner;
  }

  /** Says `text` once through the live region. */
  private announce(text: string): void {
    this.live.textContent = '';
    // A moment later, so the change from empty to text is announced even if the text repeats.
    setTimeout(() => {
      this.live.textContent = text;
    }, 50);
  }

  private toastContent(state: UpdateState): Node[] {
    const message = el('p', { class: 'message', part: 'message' });
    message.textContent = this.label('message', 'A new version is ready.');
    const actions = el('div', { class: 'actions', part: 'actions' });
    const reload = el('button', { class: 'button', part: 'button reload', type: 'button' });
    reload.textContent = this.label('reload-label', 'Reload');
    reload.addEventListener('click', () => this.client?.reload());
    actions.append(reload);
    if (state.live?.notesUrl) {
      const notes = el('a', {
        class: 'button secondary',
        part: 'button notes',
        href: state.live.notesUrl,
        target: '_blank',
        rel: 'noopener',
      });
      notes.textContent = this.label('notes-label', 'What’s new');
      actions.append(notes);
    }
    const close = el('button', { class: 'close', part: 'close', type: 'button' });
    close.setAttribute('aria-label', this.label('close-label', 'Close until the next version'));
    close.textContent = '×';
    close.addEventListener('click', () => this.client?.dismiss());
    actions.append(close);
    return [message, actions];
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('ov-update')) {
  customElements.define('ov-update', OvUpdate);
}

declare global {
  interface HTMLElementTagNameMap {
    'ov-update': OvUpdate;
  }
}
