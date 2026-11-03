import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Button,
  Callout,
  Control,
  Field,
  PageHeader,
  Panel,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { Crumbs } from '../core/crumbs';
import { Session } from '../core/session';

interface ImportResult {
  apps: number;
  environments: number;
  releases: number;
  note: string;
}

/** Your own account, and for team admins the team's name and its data. */
@Component({
  selector: 'app-settings',
  imports: [FormsModule, Button, Callout, Control, Field, PageHeader, Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header os-page-header title="Settings"></header>

    <section os-panel title="Your account" [level]="2">
      @if (session.me(); as me) {
        <dl class="facts">
          <dt>Name</dt>
          <dd>{{ me.name || '—' }}</dd>
          <dt>Email</dt>
          <dd>{{ me.email }}</dd>
        </dl>
      }
      <form class="stack form" (ngSubmit)="changePassword()">
        @if (passwordError(); as error) {
          <os-callout tone="danger">{{ error }}</os-callout>
        }
        <os-field label="Current password">
          <input
            os-input
            type="password"
            name="current"
            autocomplete="current-password"
            required
            [(ngModel)]="current"
          />
        </os-field>
        <os-field
          label="New password"
          hint="At least 10 characters. Your other sessions are signed out."
        >
          <input
            os-input
            type="password"
            name="next"
            autocomplete="new-password"
            required
            minlength="10"
            [(ngModel)]="next"
          />
        </os-field>
        <div>
          <button os-button type="submit" [loading]="saving()">Change password</button>
        </div>
      </form>
    </section>

    @if (team(); as t) {
      @if (session.isAdmin()) {
        <section os-panel [title]="t.name" description="The team’s name and data." [level]="2">
          <form class="inline" (ngSubmit)="rename(t.slug)">
            <os-field label="Team name" [error]="renameError()">
              <input os-input name="teamName" required maxlength="120" [(ngModel)]="teamName" />
            </os-field>
            <button os-button type="submit" [loading]="renaming()">Rename</button>
          </form>

          <div class="stack">
            <h3>Export</h3>
            <p>
              One JSON file with this team’s apps, environments, release history and integrations.
              Public keys, deploy tokens and integration keys aren’t in it: imported environments
              get new ones.
            </p>
            <div>
              <a os-button [href]="'/api/t/' + t.slug + '/export'" download>Download export</a>
            </div>
          </div>

          <div class="stack">
            <h3>Import</h3>
            <p>
              Adds what’s in an export file to this team. Apps and environments with the same names
              are updated; releases already here are skipped.
            </p>
            <label>
              <span class="os-visually-hidden">Export file</span>
              <input
                type="file"
                accept="application/json,.json"
                (change)="pick($event, t.slug)"
                [disabled]="importing()"
              />
            </label>
            @if (imported(); as r) {
              <os-callout tone="success" title="Imported">
                {{ r.apps }} apps, {{ r.environments }} environments and {{ r.releases }} releases.
                {{ r.note }}
              </os-callout>
            }
            @if (importError(); as error) {
              <os-callout tone="danger" title="Nothing was imported">{{ error }}</os-callout>
            }
          </div>
        </section>
      }
    }
  `,
  styles: `
    .form {
      max-inline-size: 28rem;
    }

    h3 {
      margin: 0;
      font-size: var(--os-text-md);
    }

    p {
      max-inline-size: 60ch;
      margin: 0;
    }

    .facts {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--os-space-2) var(--os-space-4);
      margin: 0;
    }

    dt {
      color: var(--os-fg-muted);
    }

    dd {
      margin: 0;
    }
  `,
})
export class Settings {
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  protected readonly team = computed(() => this.session.membership());
  protected readonly saving = signal(false);
  protected readonly passwordError = signal<string | null>(null);
  protected current = '';
  protected next = '';
  protected teamName = this.session.membership()?.name ?? '';
  protected readonly renaming = signal(false);
  protected readonly renameError = signal<string | null>(null);
  protected readonly importing = signal(false);
  protected readonly imported = signal<ImportResult | null>(null);
  protected readonly importError = signal<string | null>(null);

  constructor() {
    inject(Crumbs).trail.set([{ label: 'Settings' }]);
  }

  protected async changePassword(): Promise<void> {
    this.saving.set(true);
    this.passwordError.set(null);
    try {
      await this.api.put('/api/me/password', { current: this.current, next: this.next });
      this.current = '';
      this.next = '';
      this.toaster.show('Changed your password.', { tone: 'success' });
    } catch (error) {
      this.passwordError.set(errorText(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async rename(slug: string): Promise<void> {
    this.renaming.set(true);
    this.renameError.set(null);
    try {
      await this.api.patch(`/api/t/${encodeURIComponent(slug)}`, { name: this.teamName });
      await this.session.load();
      this.toaster.show('Renamed the team.', { tone: 'success' });
    } catch (error) {
      this.renameError.set(errorText(error));
    } finally {
      this.renaming.set(false);
    }
  }

  protected async pick(event: Event, slug: string): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.importing.set(true);
    this.imported.set(null);
    this.importError.set(null);
    try {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('That file isn’t JSON. Choose a file you exported from OpenVersion.');
      }
      this.imported.set(
        await this.api.post<ImportResult>(`/api/t/${encodeURIComponent(slug)}/import`, data),
      );
    } catch (error) {
      this.importError.set(errorText(error));
    } finally {
      this.importing.set(false);
      input.value = '';
    }
  }
}
