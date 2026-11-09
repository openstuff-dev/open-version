import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { type AppSummary, type Integration, readPublishKeyPaste, type Role } from '@open-version/contracts';
import { allAnnounceGroups } from '@openstuff-dev/ui';
import {
  Badge,
  Button,
  Callout,
  Cell,
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
  SectionHeader,
  Skeleton,
  StatusDot,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { parseGroups } from '../environment/integrations-tab';
import { onReturn, slowLoading } from '../../core/loading';
import { Session } from '../../core/session';
import { ServerConnections } from './server-connections';

/** Every environment's integrations in one list, with how their posts went. */
@Component({
  selector: 'app-integrations',
  imports: [
    FormsModule,
    RouterLink,
    Badge,
    Button,
    Callout,
    Cell,
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
    SectionHeader,
    ServerConnections,
    Skeleton,
    StatusDot,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Integrations"
      description="Where release notes go, and the OpenStuff apps this server connects to."
    ></header>

    @if (serverAdmin()) {
      <app-server-connections tenant="team" [announceGroups]="groups()" />
    }

    @if (team()) {
      <div class="team-head">
        <hgroup>
          <h2>Release notes</h2>
          <p>Post each release’s notes to OpenAnnounce, so people see what changed.</p>
        </hgroup>
        @if (session.isAdmin() && integrations()?.length && free().length) {
          <button type="button" os-button (click)="openAdd()">Add</button>
        }
      </div>
      @if (!session.isAdmin()) {
        <os-callout tone="info" title="Read only">
          Only admins change integrations. Ask an admin to set one up or change it.
        </os-callout>
      }
      @if (error(); as error) {
        <os-callout tone="danger" title="The integrations didn’t load">{{ error }}</os-callout>
      }
      @if (integrations(); as list) {
        @if (list.length) {
          <os-data-table caption="Integrations" [columns]="columns" [rows]="list" rowKey="id">
            <ng-template os-cell="appName" let-i>
              <span>
                <a
                  [routerLink]="['/t', team(), 'apps', i.appSlug, i.environmentName]"
                  [queryParams]="{ tab: 'integrations' }"
                  >{{ i.appName }}</a
                >
                <span
                  os-badge
                  class="mono env"
                  [tone]="i.environmentName === 'production' ? 'brand' : 'neutral'"
                  >{{ i.environmentName }}</span
                >
              </span>
            </ng-template>
            <ng-template os-cell="kind" let-i>
              OpenAnnounce
              <span class="os-cell-sub mono">{{ i.url }}</span>
            </ng-template>
            <ng-template os-cell="enabled" let-i>
              @if (!i.enabled) {
                <span os-status-dot tone="neutral">Off</span>
              } @else if (!i.hasKey) {
                <span os-status-dot tone="warning">No publish key</span>
              } @else if (i.failed) {
                <span os-status-dot tone="danger">{{ i.failed }} couldn’t post</span>
                @if (i.lastError) {
                  <span class="os-cell-sub">{{ i.lastError }}</span>
                }
              } @else {
                <span os-status-dot tone="success">On</span>
              }
            </ng-template>
            <ng-template os-cell="sent" let-i
              ><span class="nums">{{ i.sent }}</span></ng-template
            >
          </os-data-table>
        } @else {
          <os-empty-state title="No integrations yet" bordered>
            @if (!session.isAdmin()) {
              Ask an admin to post release notes to OpenAnnounce, so people see what changed.
            } @else if (apps()?.length === 0) {
              Add an app first.
              <div os-actions>
                <a os-button variant="primary" [routerLink]="['/t', team(), 'apps']">Apps</a>
              </div>
            } @else {
              Post each release’s notes to OpenAnnounce, so people see what changed.
              <div os-actions>
                <button type="button" os-button variant="primary" (click)="openAdd()">Add</button>
              </div>
            }
          </os-empty-state>
        }
      } @else if (loading.slow()) {
        <os-skeleton [lines]="4" />
      }
    }

    <dialog os-dialog [(open)]="addOpen">
      <header os-dialog-header><h2 os-dialog-title>Post release notes</h2></header>
      <form id="add-integration" os-dialog-body class="stack" (ngSubmit)="add()">
        @if (addError(); as error) {
          <os-callout tone="danger">{{ error }}</os-callout>
        }
        <os-field label="Environment" hint="Its new releases post their notes as News.">
          <select os-select name="environment" required [(ngModel)]="environmentId">
            @for (app of free(); track app.id) {
              <optgroup [label]="app.name">
                @for (env of app.environments; track env.id) {
                  <option [value]="env.id">{{ app.name }} {{ env.name }}</option>
                }
              </optgroup>
            }
          </select>
        </os-field>
        <os-field label="OpenAnnounce URL" hint="Where your OpenAnnounce runs.">
          <input
            os-input
            name="url"
            type="url"
            inputmode="url"
            required
            placeholder="https://announce.example.com"
            [(ngModel)]="url"
          />
        </os-field>
        <os-field
          label="Publish key"
          [error]="keyError()"
          [hint]="
            keyFilled()
              ? 'Filled in the address and the key from the connection string.'
              : 'From the Systems page in OpenAnnounce: the publish key (ak_…) or the connection string shown with it.'
          "
        >
          <input
            os-input
            name="publishKey"
            type="password"
            autocomplete="off"
            class="mono"
            required
            [ngModel]="publishKey"
            (ngModelChange)="keyChanged($event)"
          />
        </os-field>
        <os-field
          label="Groups (optional)"
          hint="Slugs, comma-separated, like shop, staff. Empty: everyone."
        >
          <input os-input name="groups" [(ngModel)]="groupsText" />
        </os-field>
      </form>
      <footer os-dialog-footer>
        <button os-button os-dialog-close type="button">Cancel</button>
        <button
          os-button
          variant="primary"
          type="submit"
          form="add-integration"
          [loading]="adding()"
        >
          Add
        </button>
      </footer>
    </dialog>
  `,
  styles: `
    .team-head {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: end;
      justify-content: space-between;
    }

    hgroup {
      display: grid;
      gap: var(--os-space-1);
      margin: 0;

      & h2 {
        font-size: var(--os-text-md);
      }

      & p {
        margin: 0;
        color: var(--os-fg-light);
        font-size: var(--os-text-sm);
      }
    }

    .env {
      margin-inline-start: var(--os-space-2);
    }
  `,
})
export class Integrations {
  /** The team in the address. Empty outside one, where only server connections show. */
  readonly team = input('');
  readonly serverAdmin = input(false);
  protected readonly session = inject(Session);

  /** Every team a server admin can see, with every role: the OpenAnnounce groups to create. */
  protected readonly groups = computed(() =>
    allAnnounceGroups(this.session.me()?.teams.map((team) => team.slug) ?? [], ROLES),
  );

  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  protected readonly apps = signal<AppSummary[] | null>(null);
  protected readonly integrations = signal<Integration[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly columns = [
    { key: 'appName' as const, label: 'App' },
    { key: 'kind' as const, label: 'Posts to' },
    { key: 'enabled' as const, label: 'Status' },
    { key: 'sent' as const, label: 'Posted', align: 'end' as const },
  ];

  /** Apps with the environments that don't post release notes yet. */
  protected readonly free = computed(() => {
    const taken = new Set((this.integrations() ?? []).map((i) => i.environmentId));
    return (this.apps() ?? [])
      .map((app) => ({ ...app, environments: app.environments.filter((e) => !taken.has(e.id)) }))
      .filter((app) => app.environments.length);
  });

  protected readonly addOpen = signal(false);
  protected readonly adding = signal(false);
  protected readonly addError = signal<string | null>(null);
  protected readonly keyError = signal<string | null>(null);
  protected readonly keyFilled = signal(false);
  protected environmentId = '';
  protected url = '';
  protected publishKey = '';
  protected groupsText = '';

  constructor() {
    effect(() => {
      if (this.team()) void this.load(this.team());
    });
    inject(DestroyRef).onDestroy(
      onReturn(() => {
        if (this.team()) void this.load(this.team());
      }),
    );
  }

  /** Starts with the first free environment and the OpenAnnounce address already in use. */
  protected async openAdd(): Promise<void> {
    this.environmentId = this.free().at(0)?.environments.at(0)?.id ?? '';
    this.url = this.integrations()?.at(0)?.url ?? '';
    this.publishKey = '';
    this.keyError.set(null);
    this.keyFilled.set(false);
    this.groupsText = '';
    this.addError.set(null);
    this.addOpen.set(true);
    if (!this.url) {
      try {
        const config = await this.api.get<{ openannounce: { url: string } | null }>('/api/client-config');
        this.url ||= config.openannounce?.url ?? '';
      } catch {
        // The address is typed in instead.
      }
    }
  }

  /** A pasted OpenAnnounce connection string fills in the address and the key. */
  protected keyChanged(text: string): void {
    const paste = readPublishKeyPaste(text);
    this.keyError.set(paste.kind === 'error' ? paste.message : null);
    this.keyFilled.set(paste.kind === 'connection');
    if (paste.kind === 'connection') {
      this.url = paste.url;
      this.publishKey = paste.publishKey;
    } else {
      this.publishKey = text;
    }
  }

  protected async add(): Promise<void> {
    const team = this.team();
    this.adding.set(true);
    this.addError.set(null);
    try {
      const added = await this.api.post<Integration>(
        `/api/t/${encodeURIComponent(team)}/environments/${this.environmentId}/integrations`,
        {
          kind: 'open-announce',
          url: this.url,
          publishKey: this.publishKey,
          groups: parseGroups(this.groupsText),
          enabled: true,
        },
      );
      this.integrations.update((list) => [...(list ?? []), added]);
      this.addOpen.set(false);
      this.toaster.show(`${added.appName} ${added.environmentName} posts its release notes now`, {
        tone: 'success',
      });
    } catch (error) {
      this.addError.set(errorText(error));
    } finally {
      this.adding.set(false);
    }
  }

  private async load(team: string): Promise<void> {
    void this.loadApps(team);
    this.error.set(null);
    const show = (list: Integration[]) => {
      if (team === this.team()) this.integrations.set(list);
    };
    try {
      show(
        await this.loading.track(
          this.api.get<Integration[]>(`/api/t/${encodeURIComponent(team)}/integrations`, {
            onFresh: show,
          }),
        ),
      );
    } catch (error) {
      this.error.set(errorText(error));
    }
  }

  private async loadApps(team: string): Promise<void> {
    try {
      const apps = await this.api.get<AppSummary[]>(`/api/t/${encodeURIComponent(team)}/apps`);
      if (team === this.team()) this.apps.set(apps);
    } catch {
      // Without the apps the Add button stays hidden; the table still shows.
    }
  }
}

const ROLES: readonly Role[] = ['admin', 'developer', 'viewer'];
