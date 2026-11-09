import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { Team } from '@open-version/contracts';
import {
  Button,
  Callout,
  Cell,
  ConfirmDialog,
  Control,
  DataTable,
  Field,
  SectionHeader,
  SettingCard,
  SettingCardFooter,
  Skeleton,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { IdempotencyKey } from '../../core/idempotency';
import { slowLoading } from '../../core/loading';
import { Session } from '../../core/session';
import { exactTime } from '../../shared/labels';

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
    SectionHeader,
    SettingCard,
    SettingCardFooter,
    Skeleton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Teams"
      description="Each team has its own apps, releases and members. Add people to a team on its Members tab."
    ></header>

    <form
      os-setting-card
      title="Add a team"
      description="A team holds its own apps, releases, members and integrations."
      (ngSubmit)="create()"
    >
      @if (createError(); as error) {
        <os-callout tone="danger">{{ error }}</os-callout>
      }
      <os-field label="Team name">
        <input
          os-input
          name="name"
          required
          maxlength="120"
          placeholder="Web team"
          [(ngModel)]="name"
        />
      </os-field>
      <div os-setting-card-footer>
        <button os-button variant="primary" type="submit" [loading]="creating()">Add team</button>
      </div>
    </form>

    @if (error(); as error) {
      <os-callout tone="danger" title="The teams didn’t load">{{ error }}</os-callout>
    }
    @if (teams(); as teams) {
      <os-data-table
        caption="Teams"
        [columns]="columns"
        [rows]="rows(teams)"
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
        <ng-template os-cell="actions" let-t>
          <button
            type="button"
            os-button
            size="sm"
            variant="ghost"
            tone="danger"
            [attr.aria-label]="'Delete ' + t.name"
            (click)="remove(t)"
          >
            Delete
          </button>
        </ng-template>
      </os-data-table>
    } @else if (loading.slow()) {
      <os-skeleton [lines]="4" />
    }
  `,
  styles: `
    .nums {
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class Teams {
  /** The team in the address, if any: deleting it leaves the page for Settings outside one. */
  readonly team = input('');
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmDialog);
  private readonly toaster = inject(Toaster);
  private readonly session = inject(Session);
  protected readonly teams = signal<Team[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly columns = [
    { key: 'name' as const, label: 'Team' },
    { key: 'createdAt' as const, label: 'Added' },
    { key: 'actions' as const, label: 'Actions', align: 'end' as const },
  ];

  protected readonly date = exactTime;
  protected readonly rows = (teams: Team[]) => teams.map((t) => ({ ...t, actions: '' }));
  protected name = '';
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  private readonly key = new IdempotencyKey();

  constructor() {
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

  protected async remove(team: Team): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Delete ${team.name}?`,
      message:
        'Its apps, releases, keys and integrations are deleted, and open tabs of its apps stop hearing about new versions. ' +
        'This can’t be undone. Member accounts stay, with their other teams.',
      confirmLabel: 'Delete team',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.delete(`/api/t/${encodeURIComponent(team.slug)}`);
      this.teams.update((list) => list?.filter((t) => t.id !== team.id) ?? null);
      this.toaster.show(`Deleted ${team.name}.`, { tone: 'success' });
      await this.session.load();
      if (team.slug === this.team()) await this.router.navigate(['/settings', 'teams']);
    } catch (error) {
      this.toaster.show(errorText(error), { tone: 'danger' });
    }
  }

  private async load(): Promise<void> {
    try {
      this.teams.set(
        await this.loading.track(
          this.api.get<Team[]>('/api/teams', {
            onFresh: (t) => {
              this.teams.set(t);
            },
          }),
        ),
      );
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
