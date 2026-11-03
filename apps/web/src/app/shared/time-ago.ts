import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Tooltip } from '@openstuff-dev/ui-angular';
import { exactTime, timeAgo } from './labels';

/** "2 days ago", with the exact time in a tooltip and the datetime attribute. */
@Component({
  selector: 'app-time-ago',
  imports: [Tooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <time class="nums" tabindex="0" [attr.datetime]="iso()" [os-tooltip]="exact()">{{
      ago()
    }}</time>
  `,
})
export class TimeAgo {
  readonly iso = input.required<string>();
  protected readonly ago = computed(() => timeAgo(this.iso()));
  protected readonly exact = computed(() => exactTime(this.iso()));
}
