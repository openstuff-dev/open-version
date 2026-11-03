import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { Team } from '@open-version/contracts';
import { Button, Callout, Cell, Control, DataTable, Field, PageHeader, Skeleton } from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { IdempotencyKey } from '../core/idempotency';
import { slowLoading } from '../core/loading';
import { Session } from '../core/session';
import { exactTime } from '../shared/labels';
import { Crumbs } from '../core/crumbs';

/** For server admins: every team on this server. */
@Component({
  selector: 'app-teams',
  imports: [
    FormsModule,
    RouterLink,
    Button,
    Callout,
    Cell,
    Control,
    DataTable,
    Field,
    PageHeader,
    Skeleton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-page-header
      title="Teams"
      description="Each team has its own apps, releases and members. Add people to a team on its Members page."
    ></header>

    <form class="inline" (ngSubmit)="create()">
      <os-field label="New team" [error]="createError()">
        <input
          os-input
          name="name"
          required
          maxlength="120"
          placeholder="Web team"
          [(ngModel)]="name"
        />
      </os-field>
      <button os-button variant="primary" type="submit" [loading]="creating()">Add team</button>
    </form>

    @if (error(); as error) {
      <os-callout tone="danger" title="The teams didn’t load">{{ error }}</os-callout>
    }
    @if (teams(); as teams) {
      <os-data-table
        caption="Teams"
        [columns]="columns"
        [rows]="teams"
        rowKey="id"
        empty="No teams yet."
      >
        <ng-template os-cell="name" let-t>
          <a [routerLink]="['/t', t.slug, 'apps']">{{ t.name }}</a>
          <span class="os-cell-sub">{{ t.slug }}</span>
        </ng-template>
        <ng-template os-cell="createdAt" let-t
          ><span class="nums">{{ date(t.createdAt) }}</span></ng-template
        >
      </os-data-table>
    } @else if (loading.slow()) {
      <os-skeleton [lines]="4" />
    }
  `,
  styles: `
    .inline {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: end;
    }

    .nums {
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class Teams {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  protected readonly teams = signal<Team[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly columns = [
    { key: 'name' as const, label: 'Team' },
    { key: 'createdAt' as const, label: 'Added' },
  ];

  protected readonly date = exactTime;
  protected name = '';
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  private readonly key = new IdempotencyKey();

  constructor() {
    inject(Crumbs).trail.set([{ label: 'Teams' }]);
    void this.load();
  }

  protected async create(): Promise<void> {
    this.creating.set(true);
    this.createError.set(null);
    try {
      const team = await this.api.post<Team>('/api/teams', { name: this.name }, this.key.value);
      this.key.renew();
      this.name = '';
      const byName = (a: Team, b: Team) => a.name.localeCompare(b.name);
      this.teams.update((t) => t && [...t, team].sort(byName));
      await this.session.load();
    } catch (error) {
      this.createError.set(errorText(error));
    } finally {
      this.creating.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      this.teams.set(
        await this.loading.track(this.api.get<Team[]>('/api/teams', { onFresh: (t) => { this.teams.set(t); } })),
      );
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
