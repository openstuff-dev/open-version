import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import {
  Button,
  Callout,
  FileInput,
  SectionHeader,
  SettingCard,
  SettingCardBody,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';

interface ImportResult {
  apps: number;
  environments: number;
  releases: number;
  note: string;
}

/** The team's apps, environments and releases as one JSON file, and back again. */
@Component({
  selector: 'app-data',
  imports: [Button, Callout, FileInput, SectionHeader, SettingCard, SettingCardBody],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Export and import"
      description="Your data is yours. Keep a copy, or move it to another server. Keys and passwords are never in the file: an import makes new ones."
    ></header>

    <section
      os-setting-card
      title="Export"
      description="One JSON file with this team’s apps, environments, release history and integrations. Public keys, deploy tokens and integration keys aren’t in it: imported environments get new ones."
    >
      <div os-setting-card-body>
        <div><a os-button variant="primary" [href]="exportUrl()" download>Download export</a></div>
      </div>
    </section>

    <section
      os-setting-card
      title="Import"
      description="Adds what’s in an export file to this team. Apps and environments with the same names are updated; releases already here are skipped."
    >
      <div os-setting-card-body>
        <input
          type="file"
          os-file-input
          accept="application/json,.json"
          aria-label="Export file"
          [disabled]="importing()"
          (change)="pick($event)"
        />
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
  `,
})
export class Data {
  readonly team = input.required<string>();
  private readonly api = inject(Api);
  protected readonly importing = signal(false);
  protected readonly imported = signal<ImportResult | null>(null);
  protected readonly importError = signal<string | null>(null);

  protected exportUrl(): string {
    return `/api/t/${encodeURIComponent(this.team())}/export`;
  }

  protected async pick(event: Event): Promise<void> {
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
        await this.api.post<ImportResult>(
          `/api/t/${encodeURIComponent(this.team())}/import`,
          data,
        ),
      );
    } catch (error) {
      this.importError.set(errorText(error));
    } finally {
      this.importing.set(false);
      input.value = '';
    }
  }
}
