import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type { Environment } from '@open-version/contracts';
import { Badge, Callout, Skeleton, Tab, Tabs } from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { Crumbs } from '../../core/crumbs';
import { onReturn, slowLoading } from '../../core/loading';
import { LiveVersion } from '../../shared/live-version';
import { IntegrationsTab } from './integrations-tab';
import { KeysTab } from './keys-tab';
import { OverviewTab } from './overview-tab';
import { SettingsTab } from './settings-tab';
import { SetupTab } from './setup-tab';

const TABS = ['overview', 'setup', 'keys', 'integrations', 'settings'] as const;
type TabName = (typeof TABS)[number];

/**
 * `/t/:team/apps/:app/:env`: one environment. Each tab is its own component and loads its own
 * data when it opens; this page only loads the environment itself.
 */
@Component({
  selector: 'app-environment',
  imports: [
    Badge,
    Callout,
    IntegrationsTab,
    KeysTab,
    LiveVersion,
    OverviewTab,
    SettingsTab,
    SetupTab,
    Skeleton,
    Tab,
    Tabs,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    @if (error(); as error) {
      <os-callout tone="danger" title="This environment didn’t load">{{ error }}</os-callout>
    }
    @if (environment(); as e) {
      <header class="head">
        <div>
          <h1>{{ e.appName }}</h1>
          <p class="sub">
            <span os-badge class="mono" [tone]="e.name === 'production' ? 'brand' : 'neutral'">{{
              e.name
            }}</span>
            <span class="muted mono">{{ e.baseUrl }}</span>
          </p>
        </div>
        <div class="live">
          <span class="muted">Live</span>
          <app-live-version
            [large]="true"
            [version]="e.live?.version ?? null"
            [checks]="e.recentChecks"
          />
        </div>
      </header>

      <os-tabs label="Environment" [selected]="current()" (selectedChange)="select($event)">
        <ng-template os-tab="overview" label="Overview">
          <app-overview-tab [team]="team()" [env]="e" (changed)="environment.set($event)" />
        </ng-template>
        <ng-template os-tab="setup" label="Setup">
          <app-setup-tab [env]="e" />
        </ng-template>
        <ng-template os-tab="keys" label="Keys">
          <app-keys-tab [team]="team()" [env]="e" (changed)="environment.set($event)" />
        </ng-template>
        <ng-template os-tab="integrations" label="Integrations">
          <app-integrations-tab [team]="team()" [env]="e" />
        </ng-template>
        <ng-template os-tab="settings" label="Settings">
          <app-settings-tab [team]="team()" [env]="e" (changed)="onSettings($event)" />
        </ng-template>
      </os-tabs>
    } @else if (loading.slow()) {
      <os-skeleton [lines]="8" />
    }
  `,
  styles: `
    .head {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-4);
      align-items: end;
      justify-content: space-between;
    }

    h1 {
      margin: 0;
      font-size: var(--os-text-2xl);
      letter-spacing: -0.01em;
    }

    .sub {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
      margin: var(--os-space-1) 0 0;
      font-size: var(--os-text-sm);
    }

    .live {
      display: grid;
      gap: var(--os-space-1);
      justify-items: end;
      font-size: var(--os-text-sm);
    }
  `,
})
export class EnvironmentPage {
  readonly team = input.required<string>();
  readonly app = input.required<string>();
  /** The environment's name in the URL. */
  readonly env = input.required<string>();
  /** The open tab, from `?tab=`. */
  readonly tab = input<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly crumbs = inject(Crumbs);
  protected readonly environment = signal<Environment | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly current = signal<TabName>('overview');

  constructor() {
    effect(() => {
      const wanted = this.tab();
      this.current.set(TABS.find((t) => t === wanted) ?? 'overview');
    });
    effect(() => {
      void this.load(this.team(), this.app(), this.env());
    });
    inject(DestroyRef).onDestroy(
      onReturn(() => void this.load(this.team(), this.app(), this.env())),
    );
  }

  protected select(tab: string | undefined): void {
    const name = TABS.find((t) => t === tab) ?? 'overview';
    this.current.set(name);
    void this.router.navigate([], {
      queryParams: { tab: name === 'overview' ? null : name },
      replaceUrl: true,
    });
  }

  /** A renamed environment or app moves to its new URL. */
  protected onSettings(env: Environment): void {
    this.environment.set(env);
    if (env.name !== this.env() || env.appSlug !== this.app()) {
      void this.router.navigate(['/t', this.team(), 'apps', env.appSlug, env.name], {
        queryParams: { tab: 'settings' },
        replaceUrl: true,
      });
    }
  }

  private async load(team: string, app: string, envName: string): Promise<void> {
    this.error.set(null);
    const path = `/api/t/${encodeURIComponent(team)}/apps/${encodeURIComponent(app)}/environments/${encodeURIComponent(envName)}`;
    const show = (env: Environment) => {
      if (team !== this.team() || app !== this.app() || envName !== this.env()) return;
      this.environment.set(env);
      this.crumbs.trail.set([
        { label: 'Apps', link: ['/t', team, 'apps'] },
        { label: env.appName },
        { label: env.name, mono: true },
      ]);
    };
    try {
      show(await this.loading.track(this.api.get<Environment>(path, { onFresh: show })));
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
