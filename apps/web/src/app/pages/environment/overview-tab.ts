import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { bump, type Delivery, type Environment, type Release } from '@open-version/contracts';
import {
  Badge,
  Button,
  Callout,
  Check,
  Checkbox,
  ConfirmDialog,
  Control,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Icon,
  Skeleton,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { IdempotencyKey } from '../../core/idempotency';
import { slowLoading } from '../../core/loading';
import { Session } from '../../core/session';
import { iconRefresh } from '../../shared/icons';
import { notesPreview, SOURCE_LABELS } from '../../shared/labels';
import { TimeAgo } from '../../shared/time-ago';

/** The live version, hard refresh, publishing from the dashboard, and the release history. */
@Component({
  selector: 'app-overview-tab',
  imports: [
    FormsModule,
    Badge,
    Button,
    Callout,
    Check,
    Checkbox,
    Control,
    Dialog,
    DialogBody,
    DialogClose,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Field,
    Icon,
    Skeleton,
    TimeAgo,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    @if (session.canWrite()) {
      <div class="actions">
        <button type="button" os-button (click)="openPublish()">Publish release</button>
        <button
          type="button"
          os-button
          variant="danger"
          (click)="hardRefresh()"
          [loading]="refreshing()"
        >
          <svg os-icon [icon]="refreshIcon" size="sm"></svg>Hard refresh
        </button>
      </div>
    }

    <h2>Release history</h2>
    @if (error(); as error) {
      <os-callout tone="danger" title="The history didn’t load">{{ error }}</os-callout>
    }
    @if (releases(); as releases) {
      @if (releases.length) {
        <ol class="history">
          @for (r of releases; track r.id) {
            <li class="release" [class.is-live]="r.id === liveId()">
              <div class="line">
                <strong class="mono version">{{ r.version }}</strong>
                @if (r.id === liveId()) {
                  <span os-badge tone="success">Live</span>
                }
                @if (r.rollbackOf) {
                  <span os-badge tone="info">Rollback</span>
                }
                @if (r.hard) {
                  <span os-badge tone="warning">Hard</span>
                }
                <span class="meta muted">
                  {{ r.createdBy }} · {{ sources[r.source] }} · <app-time-ago [iso]="r.createdAt" />
                </span>
                @if (session.canWrite() && r.id !== liveId() && r.version !== liveVersion()) {
                  <button type="button" os-button size="sm" class="make-live" (click)="makeLive(r)">
                    Make live<span class="os-visually-hidden">: {{ r.version }}</span>
                  </button>
                }
              </div>
              @if (preview(r); as text) {
                @if (!hasMore(r)) {
                  <p class="notes">{{ text }}</p>
                } @else {
                  <!-- The first line, and the whole notes one click away. -->
                  <details class="notes">
                    <summary>{{ text }}</summary>
                    <div class="full">{{ r.notes }}</div>
                  </details>
                }
              } @else if (r.rollbackOf) {
                <p class="notes muted">Made {{ r.version }} live again.</p>
              }
              @for (d of r.deliveries; track d.integrationId) {
                <p class="delivery" [attr.data-status]="d.status">
                  @switch (d.status) {
                    @case ('sent') {
                      Posted to OpenAnnounce
                    }
                    @case ('pending') {
                      Posting to OpenAnnounce{{
                        d.attempts ? ' (try ' + (d.attempts + 1) + ')' : ''
                      }}…
                    }
                    @case ('failed') {
                      Couldn’t post: {{ d.lastError || 'unknown reason' }}
                    }
                  }
                  @if (
                    d.status !== 'sent' &&
                    session.canWrite() &&
                    (d.status === 'failed' || d.lastError)
                  ) {
                    <button type="button" os-button size="sm" variant="ghost" (click)="retry(r, d)">
                      Retry<span class="os-visually-hidden"> posting {{ r.version }}</span>
                    </button>
                  }
                </p>
              }
            </li>
          }
        </ol>
      } @else {
        <os-empty-state title="Nothing released yet" bordered [level]="3">
          Publish the first release from CI with
          <code class="mono">npx openversion release</code>, or with Publish release above.
        </os-empty-state>
      }
    } @else if (loading.slow()) {
      <os-skeleton [lines]="6" />
    }

    <dialog os-dialog [(open)]="publishOpen">
      <header os-dialog-header><h2 os-dialog-title>Publish a release</h2></header>
      <form id="publish" os-dialog-body class="stack" (ngSubmit)="publish()">
        @if (publishError(); as error) {
          <os-callout tone="danger">{{ error }}</os-callout>
        }
        <os-field
          label="Version"
          [hint]="'Higher than ' + (liveVersion() ?? 'the live one') + '. CI usually does this.'"
        >
          <input
            os-input
            name="version"
            class="mono"
            required
            [(ngModel)]="version"
            autocomplete="off"
          />
        </os-field>
        <os-field label="Notes (optional)" hint="Markdown. People see them under What’s new.">
          <textarea os-textarea name="notes" rows="4" [(ngModel)]="notes"></textarea>
        </os-field>
        <label os-check>
          <input type="checkbox" os-checkbox name="hard" [(ngModel)]="hard" />
          Hard: every open tab reloads without asking
        </label>
      </form>
      <footer os-dialog-footer>
        <button os-button os-dialog-close type="button">Cancel</button>
        <button os-button variant="primary" type="submit" form="publish" [loading]="publishing()">
          Publish {{ version }}
        </button>
      </footer>
    </dialog>
  `,
  styles: `
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      justify-content: end;
    }

    h2 {
      margin: 0;
      font-size: var(--os-text-lg);
    }

    .history {
      display: grid;
      margin: 0;
      padding: 0;
      border: 1px var(--os-border-style) var(--os-border-default);
      border-radius: var(--os-radius-lg);
      list-style: none;
    }

    .release {
      display: grid;
      gap: var(--os-space-1);
      padding: var(--os-space-3) var(--os-space-4);
    }

    .release + .release {
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
    }

    .release.is-live {
      background: var(--os-bg-surface-100);
    }

    .line {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
    }

    .version {
      font-size: var(--os-text-md);
    }

    .meta {
      font-size: var(--os-text-sm);
    }

    .make-live {
      margin-inline-start: auto;
    }

    .notes,
    .delivery {
      margin: 0;
      font-size: var(--os-text-sm);
    }

    .notes summary {
      cursor: pointer;
      overflow-wrap: anywhere;
    }

    .full {
      margin-block-start: var(--os-space-2);
      padding-inline-start: var(--os-space-3);
      border-inline-start: 2px var(--os-border-style) var(--os-border-default);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .delivery {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
      color: var(--os-fg-muted);
    }

    .delivery[data-status='sent'] {
      color: var(--os-success-text);
    }

    .delivery[data-status='failed'] {
      color: var(--os-danger-text);
    }
  `,
})
export class OverviewTab {
  readonly team = input.required<string>();
  readonly env = input.required<Environment>();
  readonly changed = output<Environment>();
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  private readonly confirm = inject(ConfirmDialog);
  protected readonly releases = signal<Release[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly refreshing = signal(false);
  protected readonly refreshIcon = iconRefresh;
  protected readonly sources = SOURCE_LABELS;
  protected readonly liveId = computed(() => this.env().live?.id ?? null);
  protected readonly liveVersion = computed(() => this.env().live?.version ?? null);
  protected readonly preview = (r: Release) => notesPreview(r.notes);
  /** Notes longer than one line get a disclosure with all of them. */
  protected readonly hasMore = (r: Release) =>
    r.notes.split('\n').filter((l) => l.trim()).length > 1;

  protected readonly publishOpen = signal(false);
  protected readonly publishing = signal(false);
  protected readonly publishError = signal<string | null>(null);
  protected version = '';
  protected notes = '';
  protected hard = false;
  private readonly key = new IdempotencyKey();

  constructor() {
    effect(() => {
      void this.load(this.env().id, this.liveId());
    });
  }

  private get base(): string {
    return `/api/t/${encodeURIComponent(this.team())}`;
  }

  protected async hardRefresh(): Promise<void> {
    const env = this.env();
    const ok = await this.confirm.confirm({
      title: 'Reload every open tab?',
      message: `Everyone who has ${env.appName} open reloads at their next check, within 5 minutes. Unsaved work in forms may be lost.`,
      confirmLabel: 'Reload every tab',
      danger: true,
    });
    if (!ok) return;
    this.refreshing.set(true);
    try {
      this.changed.emit(await this.api.post<Environment>(`${this.base}/environments/${env.id}/refresh`));
      this.toaster.show('Hard refresh sent', { tone: 'success' });
    } catch (error) {
      this.toaster.show(errorText(error), { tone: 'danger' });
    } finally {
      this.refreshing.set(false);
    }
  }

  protected openPublish(): void {
    const live = this.liveVersion();
    this.version = live ? bump(live, 'patch') : '1.0.0';
    this.notes = '';
    this.hard = false;
    this.publishError.set(null);
    this.publishOpen.set(true);
  }

  protected async publish(): Promise<void> {
    this.publishing.set(true);
    this.publishError.set(null);
    try {
      const env = await this.api.post<Environment>(
        `${this.base}/environments/${this.env().id}/releases`,
        { version: this.version, notes: this.notes, hard: this.hard },
        this.key.value,
      );
      this.key.renew();
      this.publishOpen.set(false);
      this.changed.emit(env);
      this.toaster.show(`Published ${this.version}`, { tone: 'success' });
    } catch (error) {
      this.publishError.set(errorText(error));
    } finally {
      this.publishing.set(false);
    }
  }

  protected async makeLive(release: Release): Promise<void> {
    const env = this.env();
    const ok = await this.confirm.confirm({
      title: `Make ${release.version} live?`,
      message: `Every open tab of ${env.appName} ${env.name} reloads to ${release.version}. It shows in the history as a rollback.`,
      confirmLabel: `Make ${release.version} live`,
    });
    if (!ok) return;
    try {
      this.changed.emit(await this.api.post<Environment>(`${this.base}/releases/${release.id}/live`));
      this.toaster.show(`${release.version} is live`, { tone: 'success' });
    } catch (error) {
      this.toaster.show(errorText(error), { tone: 'danger' });
    }
  }

  protected async retry(release: Release, delivery: Delivery): Promise<void> {
    try {
      await this.api.post(
        `${this.base}/releases/${release.id}/deliveries/${delivery.integrationId}/retry`,
      );
      this.toaster.show('Trying again now', { tone: 'success' });
      void this.load(this.env().id, this.liveId());
    } catch (error) {
      this.toaster.show(errorText(error), { tone: 'danger' });
    }
  }

  /** Reloads when the environment or its live release changes. */
  private async load(envId: string, _live: string | null): Promise<void> {
    this.error.set(null);
    const show = (list: Release[]) => {
      if (envId === this.env().id) this.releases.set(list);
    };
    try {
      show(
        await this.loading.track(
          this.api.get<Release[]>(`${this.base}/environments/${envId}/releases`, { onFresh: show }),
        ),
      );
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
