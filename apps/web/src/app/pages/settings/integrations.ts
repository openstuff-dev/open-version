import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Integration } from '@open-version/contracts';
import {
  Badge,
  Callout,
  Cell,
  DataTable,
  EmptyState,
  SectionHeader,
  Skeleton,
  StatusDot,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { onReturn, slowLoading } from '../../core/loading';
import { Session } from '../../core/session';

/** Every environment's integrations in one list, with how their posts went. */
@Component({
  selector: 'app-integrations',
  imports: [
    RouterLink,
    Badge,
    Callout,
    Cell,
    DataTable,
    EmptyState,
    SectionHeader,
    Skeleton,
    StatusDot,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Integrations"
      description="Where release notes go. Set one up on an environment’s Integrations tab."
    ></header>

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
          @if (session.isAdmin()) {
            Post each release’s notes to OpenAnnounce, so people see what changed. Open an app’s
            environment and go to its Integrations tab.
          } @else {
            Ask an admin to post release notes to OpenAnnounce, so people see what changed.
          }
        </os-empty-state>
      }
    } @else if (loading.slow()) {
      <os-skeleton [lines]="4" />
    }
  `,
  styles: `
    .env {
      margin-inline-start: var(--os-space-2);
    }
  `,
})
export class Integrations {
  readonly team = input.required<string>();
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  protected readonly integrations = signal<Integration[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly columns = [
    { key: 'appName' as const, label: 'App' },
    { key: 'kind' as const, label: 'Posts to' },
    { key: 'enabled' as const, label: 'Status' },
    { key: 'sent' as const, label: 'Posted', align: 'end' as const },
  ];

  constructor() {
    effect(() => {
      void this.load(this.team());
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.load(this.team())));
  }

  private async load(team: string): Promise<void> {
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
}
