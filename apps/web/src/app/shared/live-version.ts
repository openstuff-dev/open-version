import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { StatusDot, Tooltip } from '@openstuff-dev/ui-angular';
import { openTabs } from './labels';

/**
 * The live version with the live dot: green and pulsing when tabs checked in during the last
 * 5 minutes (no pulse with reduced motion), grey otherwise. The tooltip says how many.
 */
@Component({
  selector: 'app-live-version',
  imports: [StatusDot, Tooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      os-status-dot
      class="mono"
      [class.large]="large()"
      [tone]="active() ? 'success' : 'neutral'"
      [pulse]="active()"
      [os-tooltip]="tabs()"
      tabindex="0"
      >{{ version() ?? 'Nothing released'
      }}<span class="os-visually-hidden">, {{ tabs() }}</span></span
    >
  `,
  styles: `
    :host {
      display: inline-flex;
    }

    [os-status-dot] {
      color: var(--os-fg-default);
    }

    .large {
      font-size: var(--os-text-xl);
      font-weight: var(--os-font-weight-semibold);
    }
  `,
})
export class LiveVersion {
  readonly version = input.required<string | null>();
  readonly checks = input.required<number>();
  /** The big one at the top of an environment page. */
  readonly large = input(false);
  protected readonly active = computed(() => this.checks() > 0);
  protected readonly tabs = computed(() => openTabs(this.checks()));
}
