import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Member, NewMember, Role } from '@open-version/contracts';
import {
  Button,
  Callout,
  Cell,
  ConfirmDialog,
  Control,
  DataTable,
  Field,
  PageHeader,
  Skeleton,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { Crumbs } from '../core/crumbs';
import { IdempotencyKey } from '../core/idempotency';
import { onReturn, slowLoading } from '../core/loading';
import { Session } from '../core/session';
import { CopyButton } from '../shared/copy-button';
import { ROLE_LABELS } from '../shared/labels';

const ROLES: Role[] = ['developer', 'viewer', 'admin'];

/** Who signs in to this team, and what they may do. */
@Component({
  selector: 'app-members',
  imports: [
    FormsModule,
    Button,
    Callout,
    Cell,
    Control,
    CopyButton,
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
      title="Members"
      description="Developers manage apps, releases, hard refreshes and keys. Viewers only look. Admins also manage members and integrations."
    ></header>

    @if (error(); as error) {
      <os-callout tone="danger" title="The members didn’t load">{{ error }}</os-callout>
    }

    <form class="inline" (ngSubmit)="add()">
      <os-field label="Email" [error]="addError()">
        <input os-input type="email" name="email" required [(ngModel)]="email" />
      </os-field>
      <os-field label="Name (optional)">
        <input os-input name="name" [(ngModel)]="name" />
      </os-field>
      <os-field label="Role">
        <select os-select name="role" [(ngModel)]="role">
          @for (r of roles; track r) {
            <option [value]="r">{{ roleLabels[r] }}</option>
          }
        </select>
      </os-field>
      <button os-button type="submit" [loading]="adding()">Add member</button>
    </form>

    @if (newPassword(); as added) {
      <os-callout tone="info" title="Send {{ added.email }} their password">
        <p>
          This is the only time it’s shown: <code class="mono">{{ added.password }}</code>
          <app-copy-button [text]="added.password ?? ''" what="password" />
        </p>
      </os-callout>
    }

    @if (members(); as members) {
      <os-data-table
        caption="Members"
        [columns]="columns"
        [rows]="rows(members)"
        rowKey="accountId"
      >
        <ng-template os-cell="name" let-m>
          {{ m.name || m.email }}
          @if (m.name) {
            <span class="os-cell-sub">{{ m.email }}</span>
          }
        </ng-template>
        <ng-template os-cell="role" let-m>
          @if (m.accountId === me()) {
            {{ roleLabels[asRole(m.role)] }} (you)
          } @else {
            <select
              os-select
              [attr.aria-label]="'Role of ' + (m.name || m.email)"
              [ngModel]="m.role"
              (ngModelChange)="changeRole(m, $event)"
            >
              @for (r of roles; track r) {
                <option [value]="r">{{ roleLabels[r] }}</option>
              }
            </select>
          }
        </ng-template>
        <ng-template os-cell="actions" let-m>
          @if (m.accountId !== me()) {
            <button
              type="button"
              os-button
              variant="ghost"
              tone="danger"
              size="sm"
              (click)="remove(m)"
            >
              Remove
            </button>
          }
        </ng-template>
      </os-data-table>
    } @else if (loading.slow()) {
      <os-skeleton [lines]="5" />
    }
  `,
})
export class Members {
  readonly team = input.required<string>();
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  private readonly confirm = inject(ConfirmDialog);
  private readonly session = inject(Session);
  protected readonly me = () => this.session.me()?.id;
  protected readonly members = signal<Member[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly roles = ROLES;
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly asRole = (r: string) => r as Role;
  protected readonly columns = [
    { key: 'name' as const, label: 'Member' },
    { key: 'role' as const, label: 'Role' },
    { key: 'actions' as const, label: 'Actions', align: 'end' as const },
  ];

  protected rows = (members: Member[]) => members.map((m) => ({ ...m, actions: '' }));
  protected email = '';
  protected name = '';
  protected role: Role = 'developer';
  protected readonly adding = signal(false);
  protected readonly addError = signal<string | null>(null);
  protected readonly newPassword = signal<NewMember | null>(null);
  private readonly key = new IdempotencyKey();

  constructor() {
    inject(Crumbs).trail.set([{ label: 'Members' }]);
    effect(() => {
      void this.load(this.team());
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.load(this.team())));
  }

  private get base(): string {
    return `/api/t/${encodeURIComponent(this.team())}`;
  }

  protected async add(): Promise<void> {
    this.adding.set(true);
    this.addError.set(null);
    this.newPassword.set(null);
    try {
      const body = { email: this.email, name: this.name, role: this.role };
      const added = await this.api.post<NewMember>(`${this.base}/members`, body, this.key.value);
      this.key.renew();
      this.email = '';
      this.name = '';
      this.members.update((m) => (m ? [...m, added] : m));
      if (added.password) this.newPassword.set(added);
      else {
        this.toaster.show(`Added ${added.email}. They sign in with the password they have.`, {
          tone: 'success',
        });
      }
    } catch (error) {
      this.addError.set(errorText(error));
    } finally {
      this.adding.set(false);
    }
  }

  /** Changes the role at once, and puts it back if the server says no. */
  protected async changeRole(member: Member, role: Role): Promise<void> {
    const before = member.role;
    const set = (r: Role) => {
      this.members.update(
        (list) =>
          list?.map((m) => (m.accountId === member.accountId ? { ...m, role: r } : m)) ?? null,
      );
    };
    set(role);
    try {
      await this.api.patch(`${this.base}/members/${member.accountId}`, { role });
      this.toaster.show(`${member.name || member.email} is now ${ROLE_LABELS[role].toLowerCase()}.`, {
        tone: 'success',
      });
    } catch (error) {
      set(before);
      this.toaster.show(errorText(error), { tone: 'danger' });
    }
  }

  protected async remove(member: Member): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Remove ${member.name || member.email}?`,
      message:
        'They lose access to this team at once. Their account stays, and you can add them again.',
      confirmLabel: 'Remove member',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.delete(`${this.base}/members/${member.accountId}`);
      this.members.update((m) => m?.filter((x) => x.accountId !== member.accountId) ?? null);
    } catch (error) {
      this.toaster.show(errorText(error), { tone: 'danger' });
    }
  }

  private async load(team: string): Promise<void> {
    this.error.set(null);
    try {
      const members = await this.loading.track(
        this.api.get<Member[]>(`/api/t/${encodeURIComponent(team)}/members`, {
          onFresh: (m) => {
            if (team === this.team()) this.members.set(m);
          },
        }),
      );
      if (team !== this.team()) return;
      this.members.set(members);
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
