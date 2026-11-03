import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  type OnInit,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Environment, EnvironmentWithToken } from '@open-version/contracts';
import {
  Button,
  Callout,
  ConfirmDialog,
  Control,
  Field,
  Icon,
  IconButton,
  Panel,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { FreshTokens } from '../../core/fresh-tokens';
import { Session } from '../../core/session';
import { CopyButton } from '../../shared/copy-button';
import { iconX } from '../../shared/icons';

/** Is `text` an origin like https://app.example.com? Returns the origin, or null. */
export function toOrigin(text: string): string | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The public key, the deploy token (shown once) and the allowed origins. */
@Component({
  selector: 'app-keys-tab',
  imports: [
    FormsModule,
    Button,
    Callout,
    Control,
    CopyButton,
    Field,
    Icon,
    IconButton,
    Panel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <section
      os-panel
      title="Public key"
      description="Goes in the browser code. It can only read the live version, and only from the allowed origins."
      [level]="2"
    >
      <div class="key">
        <code class="mono">{{ env().publicKey }}</code>
        <app-copy-button [text]="env().publicKey" what="public key" />
      </div>
    </section>

    <section
      os-panel
      title="Deploy token"
      description="For CI: publishes releases and sends hard refreshes. Keep it in a CI secret, never in browser code."
      [level]="2"
    >
      @if (token(); as token) {
        <os-callout tone="warning" title="Copy it now, it won’t be shown again">
          <div class="key">
            <code class="mono">{{ token }}</code>
            <app-copy-button [text]="token" what="deploy token" />
          </div>
        </os-callout>
      } @else {
        <div class="key">
          <code class="mono" aria-label="Deploy token ending in {{ last4() }}">{{
            env().tokenHint
          }}</code>
        </div>
      }
      @if (session.canWrite()) {
        <div>
          <button type="button" os-button (click)="regenerate()" [loading]="regenerating()">
            Regenerate
          </button>
        </div>
      }
    </section>

    <section
      os-panel
      title="Allowed origins"
      description="Websites that may check this environment’s version. Others get a 403. Leave it empty to allow any origin."
      [level]="2"
    >
      @if (origins().length) {
        <ul class="origins">
          @for (o of origins(); track o) {
            <li>
              <span class="mono">{{ o }}</span>
              @if (session.canWrite()) {
                <button
                  type="button"
                  os-icon-button
                  variant="ghost"
                  size="sm"
                  [label]="'Remove ' + o"
                  (click)="removeOrigin(o)"
                >
                  <svg os-icon [icon]="xIcon" size="sm"></svg>
                </button>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="muted">Any origin may check the version.</p>
      }
      @if (session.canWrite()) {
        <form class="inline" (ngSubmit)="addOrigin()">
          <os-field label="Add an origin" [error]="originError()">
            <input
              os-input
              name="origin"
              inputmode="url"
              placeholder="https://shop.example.com"
              [(ngModel)]="newOrigin"
            />
          </os-field>
          <button os-button type="submit" [loading]="saving()">Add</button>
        </form>
      }
    </section>
  `,
  styles: `
    .key {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
    }

    .origins {
      display: grid;
      gap: var(--os-space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .origins li {
      display: flex;
      gap: var(--os-space-2);
      align-items: center;
      justify-content: space-between;
      max-inline-size: 32rem;
      padding: var(--os-space-1) var(--os-space-1) var(--os-space-1) var(--os-space-3);
      border: 1px var(--os-border-style) var(--os-border-default);
      border-radius: var(--os-radius-md);
    }

    p {
      margin: 0;
    }
  `,
})
export class KeysTab implements OnInit {
  readonly team = input.required<string>();
  readonly env = input.required<Environment>();
  readonly changed = output<Environment>();
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  private readonly confirm = inject(ConfirmDialog);
  private readonly fresh = inject(FreshTokens);
  protected readonly token = signal<string | null>(null);
  protected readonly regenerating = signal(false);
  protected readonly origins = signal<string[]>([]);
  protected readonly saving = signal(false);
  protected readonly originError = signal<string | null>(null);
  protected readonly xIcon = iconX;
  protected newOrigin = '';
  protected readonly last4 = () => this.env().tokenHint.slice(-4);

  constructor() {
    effect(() => {
      this.origins.set(this.env().allowedOrigins);
    });
  }

  ngOnInit(): void {
    this.token.set(this.fresh.take(this.env().id));
  }

  private get path(): string {
    return `/api/t/${encodeURIComponent(this.team())}/environments/${this.env().id}`;
  }

  protected async regenerate(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Regenerate the deploy token?',
      message:
        'The current token stops working at once. CI jobs that use it fail until you put the new one in their secret.',
      confirmLabel: 'Regenerate token',
      danger: true,
    });
    if (!ok) return;
    this.regenerating.set(true);
    try {
      const result = await this.api.post<EnvironmentWithToken>(`${this.path}/token`);
      const { deployToken, ...rest } = result;
      this.token.set(deployToken);
      this.changed.emit(rest);
      this.toaster.show('Old token revoked. New token generated.', { tone: 'success' });
    } catch (error) {
      this.toaster.show(errorText(error), { tone: 'danger' });
    } finally {
      this.regenerating.set(false);
    }
  }

  protected async addOrigin(): Promise<void> {
    const origin = toOrigin(this.newOrigin);
    if (!origin) {
      this.originError.set('Enter an origin like https://shop.example.com.');
      return;
    }
    this.originError.set(null);
    if (this.origins().includes(origin)) {
      this.newOrigin = '';
      return;
    }
    if (await this.save([...this.origins(), origin])) this.newOrigin = '';
  }

  protected async removeOrigin(origin: string): Promise<void> {
    await this.save(this.origins().filter((o) => o !== origin));
  }

  /** Shows the new list at once and puts the old one back if saving fails. */
  private async save(list: string[]): Promise<boolean> {
    const before = this.origins();
    this.origins.set(list);
    this.saving.set(true);
    try {
      this.changed.emit(await this.api.patch<Environment>(this.path, { allowedOrigins: list }));
      return true;
    } catch (error) {
      this.origins.set(before);
      this.originError.set(errorText(error));
      return false;
    } finally {
      this.saving.set(false);
    }
  }
}
