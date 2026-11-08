import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { AppSummary, Environment, RefreshPolicy } from '@open-version/contracts';
import {
  Button,
  Callout,
  Check,
  Control,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Fieldset,
  Radio,
  SettingCard,
  SettingCardFooter,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { Session } from '../../core/session';
import { urlProblem } from '../apps';

/** The environment's name and refresh policy, the app's base URL, and deleting. */
@Component({
  selector: 'app-settings-tab',
  imports: [
    FormsModule,
    Button,
    Callout,
    Check,
    Control,
    Dialog,
    DialogBody,
    DialogClose,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Fieldset,
    Radio,
    SettingCard,
    SettingCardFooter,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <form os-setting-card title="Environment" (ngSubmit)="save()">
      @if (saveError(); as e) {
        <os-callout tone="danger">{{ e }}</os-callout>
      }
      <os-field label="Name" hint="Lowercase letters, digits and dashes, like staging.">
        <input
          os-input
          name="name"
          class="mono"
          required
          [disabled]="!canWrite()"
          [(ngModel)]="name"
        />
      </os-field>
      <os-field
        label="Base URL of {{ env().appName }}"
        hint="Shared by all its environments."
        [error]="urlError()"
      >
        <input
          os-input
          name="baseUrl"
          type="url"
          required
          [disabled]="!canWrite()"
          [(ngModel)]="baseUrl"
        />
      </os-field>
      <fieldset os-fieldset>
        <legend>When a new version is live</legend>
        <label os-check>
          <input
            type="radio"
            os-radio
            name="policy"
            value="prompt"
            [disabled]="!canWrite()"
            [(ngModel)]="policy"
          />
          Ask people to reload
        </label>
        <label os-check>
          <input
            type="radio"
            os-radio
            name="policy"
            value="force"
            [disabled]="!canWrite()"
            [(ngModel)]="policy"
          />
          Reload automatically, at a safe moment
        </label>
      </fieldset>
      @if (canWrite()) {
        <div>
          <button os-button variant="primary" type="submit" [loading]="saving()">Save</button>
        </div>
      }
    </form>

    @if (session.isAdmin()) {
      <section
        os-setting-card
        tone="danger"
        [title]="onlyOne() ? 'Delete ' + env().appName : 'Delete ' + env().name"
        [description]="
          onlyOne()
            ? 'This is the app’s only environment, so this deletes the whole app with its releases and keys. Open tabs stop getting updates.'
            : 'Deletes this environment with its releases, keys and integrations. Open tabs stop getting updates.'
        "
        [level]="2"
      >
        <footer os-setting-card-footer>
          <button type="button" os-button variant="danger" (click)="openDelete()">
            {{ onlyOne() ? 'Delete app' : 'Delete environment' }}
          </button>
        </footer>
      </section>
    }

    <dialog os-dialog [(open)]="deleteOpen" size="sm">
      <header os-dialog-header>
        <h2 os-dialog-title>Delete {{ deleteName() }}?</h2>
      </header>
      <form id="delete" os-dialog-body class="stack" (ngSubmit)="remove()">
        @if (deleteError(); as e) {
          <os-callout tone="danger">{{ e }}</os-callout>
        }
        <p>
          This can’t be undone. Type <strong class="mono">{{ deleteName() }}</strong> to confirm.
        </p>
        <os-field label="Name">
          <input os-input name="confirm" autocomplete="off" [(ngModel)]="typed" />
        </os-field>
      </form>
      <footer os-dialog-footer>
        <button os-button os-dialog-close type="button">Cancel</button>
        <button
          os-button
          variant="danger"
          type="submit"
          form="delete"
          [disabled]="typed !== deleteName()"
          [loading]="deleting()"
        >
          Delete {{ deleteName() }}
        </button>
      </footer>
    </dialog>
  `,
})
export class SettingsTab {
  readonly team = input.required<string>();
  readonly env = input.required<Environment>();
  readonly changed = output<Environment>();
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toaster = inject(Toaster);
  protected readonly canWrite = this.session.canWrite;
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly urlError = signal<string | null>(null);
  protected readonly siblings = signal<number>(2);
  protected readonly onlyOne = computed(() => this.siblings() <= 1);
  protected readonly deleteName = computed(() =>
    this.onlyOne() ? this.env().appName : this.env().name,
  );

  protected readonly deleteOpen = signal(false);
  protected readonly deleting = signal(false);
  protected readonly deleteError = signal<string | null>(null);
  protected name = '';
  protected baseUrl = '';
  protected policy: RefreshPolicy = 'prompt';
  protected typed = '';

  constructor() {
    effect(() => {
      const env = this.env();
      this.name = env.name;
      this.baseUrl = env.baseUrl;
      this.policy = env.refreshPolicy;
    });
    effect(() => {
      if (this.session.isAdmin()) void this.countSiblings(this.env().appId);
    });
  }

  private get base(): string {
    return `/api/t/${encodeURIComponent(this.team())}`;
  }

  protected async save(): Promise<void> {
    const env = this.env();
    const problem = urlProblem(this.baseUrl);
    this.urlError.set(problem);
    if (problem) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      if (this.baseUrl !== env.baseUrl) {
        await this.api.patch(`${this.base}/apps/${env.appId}`, { baseUrl: this.baseUrl });
      }
      const saved = await this.api.patch<Environment>(`${this.base}/environments/${env.id}`, {
        name: this.name,
        refreshPolicy: this.policy,
      });
      this.changed.emit(saved);
      this.toaster.show('Saved', { tone: 'success' });
    } catch (error) {
      this.saveError.set(errorText(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected openDelete(): void {
    this.typed = '';
    this.deleteError.set(null);
    this.deleteOpen.set(true);
  }

  protected async remove(): Promise<void> {
    const env = this.env();
    if (this.typed !== this.deleteName()) return;
    this.deleting.set(true);
    try {
      await this.api.delete(
        this.onlyOne() ? `${this.base}/apps/${env.appId}` : `${this.base}/environments/${env.id}`,
      );
      this.deleteOpen.set(false);
      this.toaster.show(`Deleted ${this.deleteName()}`, { tone: 'success' });
      await this.router.navigate(['/t', this.team(), 'apps']);
    } catch (error) {
      this.deleteError.set(errorText(error));
    } finally {
      this.deleting.set(false);
    }
  }

  /** Whether this is the app's only environment, from the (usually stored) Apps list. */
  private async countSiblings(appId: string): Promise<void> {
    try {
      const apps = await this.api.get<AppSummary[]>(`${this.base}/apps`);
      this.siblings.set(apps.find((a) => a.id === appId)?.environments.length ?? 1);
    } catch {
      // Keep the default; the server refuses deleting the last environment anyway.
    }
  }
}
