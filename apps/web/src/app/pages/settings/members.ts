import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
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
  EmptyState,
  Field,
  onReturn,
  SecretDialog,
  SectionHeader,
  SettingCard,
  SettingCardBody,
  SettingCardFooter,
  Skeleton,
  slowLoading,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { IdempotencyKey } from '../../core/idempotency';
import { Session } from '../../core/session';
import { ROLE_LABELS } from '../../shared/labels';

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
    DataTable,
    EmptyState,
    Field,
    SectionHeader,
    SettingCard,
    SettingCardBody,
    SettingCardFooter,
    Skeleton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Members"
      description="Developers manage apps, releases, hard refreshes and keys. Viewers only look. Admins also manage members and integrations."
    ></header>

    @if (error(); as error) {
      <os-callout tone="danger" title="The members didn’t load">{{ error }}</os-callout>
    }

    <form
      os-setting-card
      title="Add a member"
      description="They get a password, shown once, for you to pass on."
      (ngSubmit)="add()"
    >
      <div os-setting-card-body class="fields">
        <os-field label="Email" [error]="addError()">
          <input #emailInput os-input type="email" name="email" required [(ngModel)]="email" />
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
      </div>
      <div os-setting-card-footer>
        <button os-button variant="primary" type="submit" [loading]="adding()">Add member</button>
      </div>
    </form>

    @if (members(); as members) {
      @if (onlyYou()) {
        <os-empty-state title="Only you so far">
          <p>Add the developers who ship your apps. They get a password to sign in with.</p>
          <div><button os-button type="button" (click)="focusEmail()">Add member</button></div>
        </os-empty-state>
      }
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
              Remove<span class="os-visually-hidden"> {{ m.name || m.email }}</span>
            </button>
          }
        </ng-template>
      </os-data-table>
    } @else if (loading.slow()) {
      <os-skeleton [lines]="5" />
    }
  `,
  styles: `
    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: end;
    }
  `,
})
export class Members {
  readonly team = input.required<string>();
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  private readonly confirm = inject(ConfirmDialog);
  private readonly secret = inject(SecretDialog);
  private readonly session = inject(Session);
  protected readonly me = () => this.session.me()?.id;
  private readonly emailInput = viewChild<ElementRef<HTMLInputElement>>('emailInput');

  /** True when you're the only member, so the empty state invites the first one. */
  protected readonly onlyYou = computed(() => {
    const list = this.members();
    return list?.every((m) => m.accountId === this.me()) ?? false;
  });

  protected focusEmail(): void {
    this.emailInput()?.nativeElement.focus();
  }

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
  private readonly key = new IdempotencyKey();

  constructor() {
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
    try {
      const body = { email: this.email, name: this.name, role: this.role };
      const added = await this.api.post<NewMember>(`${this.base}/members`, body, this.key.value);
      this.key.renew();
      this.email = '';
      this.name = '';
      this.members.update((m) => (m ? [...m, added] : m));
      if (added.password) {
        await this.secret.show({
          title: `Password for ${added.email}`,
          secret: added.password,
          what: 'password',
          instructions: 'Give it to them. They can change it under Settings › Account.',
        });
      } else {
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
