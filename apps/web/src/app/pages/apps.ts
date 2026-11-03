import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { AppSummary, NewApp } from '@open-version/contracts';
import {
  Badge,
  Button,
  Callout,
  Cell,
  Check,
  Checkbox,
  Control,
  DataTable,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Fieldset,
  Icon,
  PageHeader,
  Skeleton,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { Crumbs } from '../core/crumbs';
import { FreshTokens } from '../core/fresh-tokens';
import { IdempotencyKey } from '../core/idempotency';
import { onReturn, slowLoading } from '../core/loading';
import { Session } from '../core/session';
import { iconPlus } from '../shared/icons';
import { LiveVersion } from '../shared/live-version';
import { TimeAgo } from '../shared/time-ago';

interface Row {
  id: string;
  appSlug: string;
  app: string;
  env: string;
  live: string | null;
  checks: number;
  released: string | null;
}

/** Is `text` a URL like https://shop.example.com? */
export function urlProblem(text: string): string | null {
  try {
    const url = new URL(text.trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') return null;
  } catch {
    // Falls through.
  }
  return 'Enter a URL like https://shop.example.com.';
}

/** The dashboard: every environment of every app, with its live version. */
@Component({
  selector: 'app-apps',
  imports: [
    FormsModule,
    RouterLink,
    Badge,
    Button,
    Callout,
    Cell,
    Check,
    Checkbox,
    Control,
    DataTable,
    Dialog,
    DialogBody,
    DialogClose,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Field,
    Fieldset,
    Icon,
    LiveVersion,
    PageHeader,
    Skeleton,
    TimeAgo,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-page-header
      title="Apps"
      description="Every environment, with the version its open tabs should run."
    >
      @if (session.canWrite()) {
        <button type="button" os-button variant="primary" (click)="openCreate()">
          <svg os-icon [icon]="plusIcon" size="sm"></svg>New app
        </button>
      }
    </header>

    @if (error(); as error) {
      <os-callout tone="danger" title="The apps didn’t load">{{ error }}</os-callout>
    }

    @if (apps(); as apps) {
      @if (apps.length) {
        <os-data-table caption="Environments" [columns]="columns" [rows]="rows()" rowKey="id">
          <ng-template os-cell="app" let-r>
            <a [routerLink]="['/t', team(), 'apps', r.appSlug, r.env]">{{ r.app }}</a>
          </ng-template>
          <ng-template os-cell="env" let-r>
            <!-- The span keeps the badge its own size when the table stacks at narrow widths. -->
            <span
              ><span os-badge class="mono" [tone]="r.env === 'production' ? 'brand' : 'neutral'">{{
                r.env
              }}</span></span
            >
          </ng-template>
          <ng-template os-cell="live" let-r>
            <app-live-version [version]="r.live" [checks]="r.checks" />
          </ng-template>
          <ng-template os-cell="released" let-r>
            @if (r.released) {
              <app-time-ago [iso]="r.released" />
            } @else {
              <span class="muted">Never</span>
            }
          </ng-template>
        </os-data-table>
      } @else {
        <os-empty-state title="No apps yet" bordered>
          An app is a web app your team runs. Each of its environments (production, staging) tells
          its open tabs when a new version is live.
          @if (session.canWrite()) {
            <div os-actions>
              <button type="button" os-button variant="primary" (click)="openCreate()">
                New app
              </button>
            </div>
          }
        </os-empty-state>
      }
    } @else if (loading.slow()) {
      <os-skeleton [lines]="6" />
    }

    <dialog os-dialog [(open)]="createOpen">
      <header os-dialog-header><h2 os-dialog-title>New app</h2></header>
      <form id="new-app" os-dialog-body class="stack" (ngSubmit)="create()">
        @if (createError(); as error) {
          <os-callout tone="danger">{{ error }}</os-callout>
        }
        <os-field label="Name" hint="Like Shop or Back office.">
          <input
            os-input
            name="name"
            required
            maxlength="120"
            autocomplete="off"
            [(ngModel)]="name"
          />
        </os-field>
        <os-field
          label="Base URL"
          hint="Where people open it. Its origin may check the version."
          [error]="urlError()"
        >
          <input
            os-input
            type="url"
            name="baseUrl"
            required
            inputmode="url"
            placeholder="https://shop.example.com"
            [(ngModel)]="baseUrl"
            (blur)="checkUrl()"
          />
        </os-field>
        <fieldset os-fieldset>
          <legend>Environments</legend>
          <label os-check>
            <input type="checkbox" os-checkbox name="production" [(ngModel)]="production" />
            <span class="mono">production</span>
          </label>
          <label os-check>
            <input type="checkbox" os-checkbox name="staging" [(ngModel)]="staging" />
            <span class="mono">staging</span>
          </label>
        </fieldset>
      </form>
      <footer os-dialog-footer>
        <button os-button os-dialog-close type="button">Cancel</button>
        <button os-button variant="primary" type="submit" form="new-app" [loading]="creating()">
          Create app
        </button>
      </footer>
    </dialog>
  `,
})
export class Apps {
  readonly team = input.required<string>();
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toaster = inject(Toaster);
  private readonly fresh = inject(FreshTokens);
  protected readonly apps = signal<AppSummary[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly plusIcon = iconPlus;
  protected readonly columns = [
    { key: 'app' as const, label: 'App' },
    { key: 'env' as const, label: 'Environment' },
    { key: 'live' as const, label: 'Live version' },
    { key: 'released' as const, label: 'Last released' },
  ];

  protected readonly rows = computed<Row[]>(() =>
    (this.apps() ?? []).flatMap((a) =>
      a.environments.map((e) => ({
        id: e.id,
        appSlug: a.slug,
        app: a.name,
        env: e.name,
        live: e.liveVersion,
        checks: e.recentChecks,
        released: e.lastReleasedAt,
      })),
    ),
  );

  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected readonly urlError = signal<string | null>(null);
  protected name = '';
  protected baseUrl = '';
  protected production = true;
  protected staging = false;
  private readonly key = new IdempotencyKey();

  constructor() {
    inject(Crumbs).trail.set([{ label: 'Apps' }]);
    effect(() => {
      void this.load(this.team());
    });
    // The live dots go stale; check again when people come back to the tab.
    inject(DestroyRef).onDestroy(onReturn(() => void this.load(this.team())));
  }

  protected openCreate(): void {
    this.name = '';
    this.baseUrl = '';
    this.production = true;
    this.staging = false;
    this.createError.set(null);
    this.urlError.set(null);
    this.createOpen.set(true);
  }

  protected checkUrl(): void {
    this.urlError.set(this.baseUrl ? urlProblem(this.baseUrl) : null);
  }

  protected async create(): Promise<void> {
    const problem = urlProblem(this.baseUrl);
    this.urlError.set(problem);
    const environments = [this.production && 'production', this.staging && 'staging'].filter(
      (e): e is string => Boolean(e),
    );
    if (!environments.length) {
      this.createError.set('Pick at least one environment.');
      return;
    }
    if (problem) return;
    this.creating.set(true);
    this.createError.set(null);
    try {
      const created = await this.api.post<NewApp>(
        `/api/t/${encodeURIComponent(this.team())}/apps`,
        { name: this.name, baseUrl: this.baseUrl, environments },
        this.key.value,
      );
      this.key.renew();
      for (const env of created.environments) this.fresh.put(env.id, env.deployToken);
      this.apps.update((list) =>
        [...(list ?? []), created.app].sort((a, b) => a.name.localeCompare(b.name)),
      );
      this.createOpen.set(false);
      this.toaster.show('App created', { tone: 'success' });
      const first = created.environments[0];
      await this.router.navigate(['/t', this.team(), 'apps', created.app.slug, first.name], {
        queryParams: { tab: 'setup' },
      });
    } catch (error) {
      this.createError.set(errorText(error));
    } finally {
      this.creating.set(false);
    }
  }

  private async load(team: string): Promise<void> {
    this.error.set(null);
    try {
      const apps = await this.loading.track(
        this.api.get<AppSummary[]>(`/api/t/${encodeURIComponent(team)}/apps`, {
          onFresh: (a) => {
            if (team === this.team()) this.apps.set(a);
          },
        }),
      );
      if (team === this.team()) this.apps.set(apps);
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
