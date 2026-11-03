import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Button, EmptyState } from '@openstuff-dev/ui-angular';
import { Session } from '../core/session';

/** `/`: straight to the Apps page of this person's team. */
@Component({
  selector: 'app-start',
  imports: [RouterLink, Button, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session.me(); as me) {
      @if (me.isServerAdmin) {
        <os-empty-state title="Make your first team" [level]="1">
          A team has its own apps, environments, releases and members.
          <div os-actions>
            <a os-button variant="primary" routerLink="/teams">Make a team</a>
          </div>
        </os-empty-state>
      } @else {
        <os-empty-state title="You’re not in a team yet" [level]="1">
          Ask an admin of your team to add you, then sign in again.
        </os-empty-state>
      }
    }
  `,
})
export class Start {
  protected readonly session = inject(Session);

  constructor() {
    const router = inject(Router);
    const teams = this.session.me()?.teams ?? [];
    const target = teams.find((t) => t.slug === this.session.team()) ?? teams.at(0);
    if (target) void router.navigate(['/t', target.slug, 'apps'], { replaceUrl: true });
  }
}
