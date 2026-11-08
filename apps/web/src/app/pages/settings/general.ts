import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Button,
  Callout,
  Control,
  Field,
  SectionHeader,
  SettingCard,
  SettingCardFooter,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { Session } from '../../core/session';

/** The team's name. Shown in the switcher and to everyone in the team. */
@Component({
  selector: 'app-general',
  imports: [
    FormsModule,
    Button,
    Callout,
    Control,
    Field,
    SectionHeader,
    SettingCard,
    SettingCardFooter,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="General"
      description="The team’s name, shown in the switcher and to everyone in it."
    ></header>

    <form os-setting-card title="Team name" (ngSubmit)="rename()">
      @if (error(); as error) {
        <os-callout tone="danger">{{ error }}</os-callout>
      }
      <os-field label="Team name">
        <input os-input name="teamName" required maxlength="120" [(ngModel)]="teamName" />
      </os-field>
      <div os-setting-card-footer>
        <button os-button variant="primary" type="submit" [loading]="renaming()">Rename</button>
      </div>
    </form>
  `,
})
export class General {
  readonly team = input.required<string>();
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  private readonly session = inject(Session);
  protected teamName = this.session.membership()?.name ?? '';
  protected readonly renaming = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async rename(): Promise<void> {
    this.renaming.set(true);
    this.error.set(null);
    try {
      await this.api.patch(`/api/t/${encodeURIComponent(this.team())}`, { name: this.teamName });
      await this.session.load();
      this.toaster.show('Renamed the team.', { tone: 'success' });
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.renaming.set(false);
    }
  }
}
