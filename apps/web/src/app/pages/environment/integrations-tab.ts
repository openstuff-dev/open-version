import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Environment, Integration } from '@open-version/contracts';
import {
  Button,
  Callout,
  Check,
  Control,
  Field,
  Panel,
  Skeleton,
  Switch,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { slowLoading } from '../../core/loading';
import { Session } from '../../core/session';

/** "shop, all-staff" → ["shop", "all-staff"]. */
export function parseGroups(text: string): string[] {
  return text
    .split(',')
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
}

/** Posting release notes to OpenAnnounce as News. */
@Component({
  selector: 'app-integrations-tab',
  imports: [FormsModule, Button, Callout, Check, Control, Field, Panel, Skeleton, Switch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    @if (error(); as error) {
      <os-callout tone="danger" title="The integrations didn’t load">{{ error }}</os-callout>
    }
    @if (loaded()) {
      <section
        os-panel
        title="OpenAnnounce"
        description="Each new release’s notes show up in OpenAnnounce as a News message, “{{
          env().appName
        }} 1.4.2”, so people see what changed."
        [level]="2"
      >
        <label os-check>
          <input
            type="checkbox"
            os-switch
            name="enabled"
            [disabled]="!session.isAdmin() || busy()"
            [ngModel]="enabled()"
            (ngModelChange)="toggle($event)"
          />
          Post release notes to OpenAnnounce
        </label>

        @if (enabled()) {
          <form class="stack form" (ngSubmit)="save()">
            @if (formError(); as e) {
              <os-callout tone="danger">{{ e }}</os-callout>
            }
            <os-field label="OpenAnnounce URL" hint="Where your OpenAnnounce runs.">
              <input
                os-input
                name="url"
                type="url"
                inputmode="url"
                required
                placeholder="https://announce.example.com"
                [disabled]="!session.isAdmin()"
                [(ngModel)]="url"
              />
            </os-field>
            <os-field
              label="Publish key"
              [hint]="
                integration()?.hasKey
                  ? 'A key is saved. Leave this empty to keep it.'
                  : 'From the system’s Setup tab in OpenAnnounce, starts with ak_.'
              "
            >
              <input
                os-input
                name="publishKey"
                type="password"
                autocomplete="off"
                class="mono"
                [required]="!integration()?.hasKey"
                [disabled]="!session.isAdmin()"
                [(ngModel)]="publishKey"
              />
            </os-field>
            <os-field
              label="Groups (optional)"
              hint="Slugs, comma-separated, like shop, staff. Empty: everyone."
            >
              <input os-input name="groups" [disabled]="!session.isAdmin()" [(ngModel)]="groups" />
            </os-field>
            @if (session.isAdmin()) {
              <div class="inline">
                <button os-button variant="primary" type="submit" [loading]="busy()">Save</button>
                <button
                  os-button
                  type="button"
                  [disabled]="!integration()"
                  [loading]="testing()"
                  (click)="test()"
                >
                  Test connection
                </button>
              </div>
              @if (!integration()) {
                <p class="muted hint">Save first, then test the connection.</p>
              }
            }
            @if (testResult(); as r) {
              <os-callout [tone]="r.ok ? 'success' : 'danger'" role="status">{{
                r.text
              }}</os-callout>
            }
          </form>
        }
        @if (!session.isAdmin()) {
          <p class="muted hint">Only admins change integrations.</p>
        }
      </section>
    } @else if (loading.slow()) {
      <os-skeleton [lines]="5" />
    }
  `,
  styles: `
    .form {
      max-inline-size: 32rem;
    }

    .hint {
      margin: 0;
      font-size: var(--os-text-sm);
    }
  `,
})
export class IntegrationsTab {
  readonly team = input.required<string>();
  readonly env = input.required<Environment>();
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  protected readonly loading = slowLoading();
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly integration = signal<Integration | null>(null);
  protected readonly enabled = signal(false);
  protected readonly busy = signal(false);
  protected readonly testing = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly testResult = signal<{ ok: boolean; text: string } | null>(null);
  protected url = '';
  protected publishKey = '';
  protected groups = '';

  constructor() {
    effect(() => {
      void this.load(this.env().id);
    });
  }

  private get base(): string {
    return `/api/t/${encodeURIComponent(this.team())}`;
  }

  private show(found: Integration | null): void {
    this.integration.set(found);
    this.enabled.set(found?.enabled ?? false);
    this.url = found?.url ?? '';
    this.groups = found?.groups.join(', ') ?? '';
    this.publishKey = '';
  }

  /** Switching off saves at once; switching on shows the form (saved with Save). */
  protected async toggle(on: boolean): Promise<void> {
    this.enabled.set(on);
    this.testResult.set(null);
    const current = this.integration();
    if (!current) return;
    this.busy.set(true);
    try {
      this.show(await this.api.patch<Integration>(`${this.base}/integrations/${current.id}`, { enabled: on }));
      this.toaster.show(on ? 'Release notes go to OpenAnnounce again' : 'Stopped posting to OpenAnnounce', {
        tone: 'success',
      });
    } catch (error) {
      this.enabled.set(!on);
      this.toaster.show(errorText(error), { tone: 'danger' });
    } finally {
      this.busy.set(false);
    }
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    this.formError.set(null);
    const body = {
      url: this.url,
      groups: parseGroups(this.groups),
      enabled: true,
      ...(this.publishKey ? { publishKey: this.publishKey } : {}),
    };
    try {
      const current = this.integration();
      this.show(
        current
          ? await this.api.patch<Integration>(`${this.base}/integrations/${current.id}`, body)
          : await this.api.post<Integration>(`${this.base}/environments/${this.env().id}/integrations`, {
              kind: 'open-announce',
              ...body,
            }),
      );
      this.toaster.show('Saved the OpenAnnounce integration', { tone: 'success' });
    } catch (error) {
      this.formError.set(errorText(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Tests the URL and key in the form (or the saved key), without saving them. */
  protected async test(): Promise<void> {
    const current = this.integration();
    if (!current) return;
    this.testing.set(true);
    this.testResult.set(null);
    try {
      await this.api.post(`${this.base}/integrations/${current.id}/test`, {
        url: this.url,
        ...(this.publishKey ? { publishKey: this.publishKey } : {}),
      });
      this.testResult.set({ ok: true, text: 'OpenAnnounce accepted the key.' });
    } catch (error) {
      this.testResult.set({ ok: false, text: errorText(error) });
    } finally {
      this.testing.set(false);
    }
  }

  private async load(envId: string): Promise<void> {
    this.error.set(null);
    try {
      const list = await this.loading.track(
        this.api.get<Integration[]>(`${this.base}/environments/${envId}/integrations`),
      );
      if (envId !== this.env().id) return;
      this.show(list.at(0) ?? null);
      this.loaded.set(true);
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
