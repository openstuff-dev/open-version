import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { connectionFor, type Environment } from '@open-version/contracts';
import {
  CodeBlock,
  SecretDialog,
  SegmentedControl,
} from '@openstuff-dev/ui-angular';
import { FreshTokens } from '../../core/fresh-tokens';

/** Where people and apps reach this server: the page's own origin. */
const serverUrl = () => globalThis.location.origin;

export function setupSnippets(env: Environment, url = serverUrl()) {
  const configure = `import { configure } from '@openstuff-dev/version';
import '@openstuff-dev/version/update'; // <ov-update>

configure({
  url: '${url}',
  publicKey: '${env.publicKey}',
  version: import.meta.env.VITE_APP_VERSION, // or __APP_VERSION__, set at build time
});`;
  const page = `<ov-update></ov-update>`;
  return {
    install: { npm: 'npm install @openstuff-dev/version', pnpm: 'pnpm add @openstuff-dev/version', yarn: 'yarn add @openstuff-dev/version' },
    configure,
    page,
    cli: 'npx openversion release --minor --notes-file CHANGELOG.md',
    ci: `# After your deploy step:
- name: Tell open tabs about the new version
  run: npx openversion release --minor --notes-file CHANGELOG.md
  env:
    OPENVERSION_URL: ${url}
    OPENVERSION_TOKEN: \${{ secrets.OPENVERSION_TOKEN }}`,
  };
}

/** How to add OpenVersion to the app and publish from CI, with this environment's values. */
@Component({
  selector: 'app-setup-tab',
  imports: [
    SegmentedControl,
    CodeBlock,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <p class="lead">
      Add the client to {{ env().appName }}, give the build its version, and publish a release after
      each deploy. The values below are this environment’s.
    </p>

    <os-segmented-control
      label="Package manager or CI"
      name="setup-view"
      [options]="views"
      [(value)]="view"
    />

    @switch (view()) {
      @case ('ci') {
        <div class="stack">
          <p>
            Publish after each deploy. The CLI reads <code class="mono">OPENVERSION_URL</code> and
            <code class="mono">OPENVERSION_TOKEN</code> (the deploy token, from the Keys tab).
          </p>
          <os-code-block [code]="snippets().cli" what="command" />
          <h3>GitHub Actions</h3>
          <os-code-block [code]="snippets().ci" what="workflow step" />
        </div>
      }
      @default {
        <div class="stack">
          <h3>1. Install</h3>
          <os-code-block [code]="install()" what="install command" />
          <h3>2. Configure it once, early</h3>
          <os-code-block [code]="snippets().configure" what="configure code" />
          <h3>3. Show the update toast</h3>
          <os-code-block [code]="snippets().page" what="element" />
        </div>
      }
    }
  `,
  styles: `
    .lead {
      max-inline-size: 65ch;
      margin: 0;
    }

    h3 {
      margin: var(--os-space-2) 0 0;
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-semibold);
    }

    p {
      margin: 0;
    }
  `,
})
export class SetupTab implements OnInit {
  readonly env = input.required<Environment>();
  private readonly fresh = inject(FreshTokens);
  protected readonly snippets = computed(() => setupSnippets(this.env()));
  // A segmented control, not nested os-tabs: tabs inside a tab froze the page.
  protected readonly views = [
    { value: 'npm', label: 'npm' },
    { value: 'pnpm', label: 'pnpm' },
    { value: 'yarn', label: 'yarn' },
    { value: 'ci', label: 'CI' },
  ] as const;

  protected readonly view = signal<'npm' | 'pnpm' | 'yarn' | 'ci'>('npm');
  protected readonly install = computed(() => {
    const view = this.view();
    return this.snippets().install[view === 'ci' ? 'npm' : view];
  });

  private readonly secret = inject(SecretDialog);

  /** A deploy token made a moment ago (a new app), shown once with its connection string. */
  ngOnInit(): void {
    const token = this.fresh.take(this.env().id);
    if (!token) return;
    void this.secret.show({
      title: 'Your new deploy token',
      secret: token,
      what: 'deploy token',
      instructions: 'CI uses it to publish releases. Save it as the secret OPENVERSION_TOKEN.',
      connection: connectionFor(this.env(), token, globalThis.location.origin),
    });
  }
}
