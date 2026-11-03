import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { Role } from '@open-version/contracts';
import {
  Breadcrumbs,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Page,
  PopoverTrigger,
} from '@openstuff-dev/ui-angular';
import { Crumbs } from './core/crumbs';
import { Session } from './core/session';
import {
  iconApps,
  iconCheck,
  iconChevrons,
  iconDocs,
  iconExternal,
  iconIntegrations,
  iconMembers,
  iconMenu,
  iconSettings,
  iconSignOut,
  iconTeams,
} from './shared/icons';
import { ROLE_LABELS } from './shared/labels';

type IconNode = typeof iconApps;
interface NavLink {
  path: string;
  label: string;
  icon: IconNode;
  roles: readonly Role[];
}

/** The pages in the sidebar, and who sees each. */
const LINKS: NavLink[] = [
  { path: 'apps', label: 'Apps', icon: iconApps, roles: ['admin', 'developer', 'viewer'] },
  {
    path: 'integrations',
    label: 'Integrations',
    icon: iconIntegrations,
    roles: ['admin', 'developer', 'viewer'],
  },
  { path: 'members', label: 'Members', icon: iconMembers, roles: ['admin'] },
];

/** Where the Docs link goes: how to add the client and publish from CI. */
export const DOCS_URL = 'https://github.com/openstuff-dev/open-version#readme';

/** "Demo team" → "DT", "Acme" → "AC". */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const pair = words.length > 1 ? words.slice(0, 2).map((w) => w.charAt(0)).join('') : name.slice(0, 2);
  return (pair || '?').toUpperCase();
}

/**
 * The frame around every signed-in page, laid out like OpenPurpose's: the brand row, the team
 * switch, the pages, and at the bottom Settings and who is signed in, with sign-out.
 */
@Component({
  selector: 'app-shell',
  imports: [
    Breadcrumbs,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    Icon,
    IconButton,
    Menu,
    MenuItem,
    MenuLabel,
    MenuSeparator,
    Page,
    PopoverTrigger,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="os-shell" [attr.data-open]="menuOpen() ? '' : null">
      <nav class="os-shell-sidebar" id="sidebar" aria-label="Main">
        <a class="os-shell-brand brand" routerLink="/">
          <!-- The OpenStuff ring with OpenVersion's half (old and new), as on version.openstuff.dev. -->
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <path
              class="ring"
              fill-rule="evenodd"
              d="M16 1.5a14.5 14.5 0 1 0 0 29a14.5 14.5 0 1 0 0-29Zm0 4a10.5 10.5 0 1 1 0 21a10.5 10.5 0 1 1 0-21Z"
            />
            <path class="glyph" d="M10.75 17.4a5.25 5.25 0 0 1 10.5 0Z" />
          </svg>
          OpenVersion
        </a>

        @if (me(); as me) {
          @if (me.teams.length || me.isServerAdmin) {
            <div class="ws">
              <button type="button" class="ws-button" [os-popover-trigger]="wsMenu">
                @if (session.membership(); as current) {
                  <span class="badge" aria-hidden="true">{{ initials(current.name) }}</span>
                  <span class="ws-text">
                    <strong>{{ current.name }}</strong>
                    <small>{{ roleLabels[current.role] }}</small>
                  </span>
                } @else {
                  <span class="badge neutral" aria-hidden="true">?</span>
                  <span class="ws-text">
                    <strong>Choose a team</strong>
                    <small>{{ me.teams.length }} available</small>
                  </span>
                }
                <svg os-icon [icon]="icons.chevrons" size="sm" class="chevrons"></svg>
              </button>
              <div os-menu #wsMenu="osPopover" class="ws-menu" aria-label="Switch team">
                @if (me.teams.length) {
                  <div os-menu-label>Teams</div>
                  @for (t of me.teams; track t.slug) {
                    <button
                      type="button"
                      os-menu-item
                      role="menuitemradio"
                      [attr.aria-checked]="t.slug === team()"
                      (click)="pick(t.slug)"
                    >
                      <span class="badge sm" aria-hidden="true">{{ initials(t.name) }}</span>
                      {{ t.name }}
                      @if (t.slug === team()) {
                        <svg os-icon [icon]="icons.check" size="sm" class="checked"></svg>
                      }
                    </button>
                  }
                }
                @if (me.isServerAdmin) {
                  <hr os-menu-separator />
                  <a os-menu-item routerLink="/teams">
                    <svg os-icon [icon]="icons.teams" size="sm"></svg>Manage teams
                  </a>
                }
              </div>
            </div>
          }
        }

        @if (team(); as t) {
          <ul>
            @for (link of links(); track link.path) {
              <li>
                <a
                  [routerLink]="['/t', t, link.path]"
                  routerLinkActive="active"
                  ariaCurrentWhenActive="page"
                >
                  <svg os-icon [icon]="link.icon" size="sm"></svg>{{ link.label }}
                </a>
              </li>
            }
            <li>
              <a [href]="docsUrl" target="_blank" rel="noopener">
                <svg os-icon [icon]="icons.docs" size="sm"></svg>Docs
                <svg os-icon [icon]="icons.external" size="sm" class="external"></svg>
                <span class="os-visually-hidden">(opens in a new tab)</span>
              </a>
            </li>
          </ul>
        }

        <div class="rail-foot">
          <ul>
            <li>
              <a routerLink="/settings" routerLinkActive="active" ariaCurrentWhenActive="page">
                <svg os-icon [icon]="icons.settings" size="sm"></svg>Settings
              </a>
            </li>
          </ul>
          @if (me(); as me) {
            <div class="me-row">
              <span class="avatar" aria-hidden="true">{{ initials(me.name || me.email) }}</span>
              <span>
                {{ me.name || me.email }}
                <small>{{ roleLine() }}</small>
              </span>
              <button
                os-icon-button
                variant="ghost"
                type="button"
                label="Sign out"
                title="Sign out"
                (click)="signOut()"
              >
                <svg os-icon [icon]="icons.signOut" size="sm"></svg>
              </button>
            </div>
          }
        </div>
      </nav>

      <div class="os-shell-content">
        <header class="os-shell-topbar">
          <button
            type="button"
            os-icon-button
            class="os-shell-menu"
            variant="ghost"
            label="Menu"
            aria-controls="sidebar"
            [attr.aria-expanded]="menuOpen()"
            (click)="menuOpen.set(!menuOpen())"
          >
            <svg os-icon [icon]="icons.menu"></svg>
          </button>
          @if (crumbs.trail().length) {
            <nav os-breadcrumbs label="You are here" class="crumbs">
              <ol>
                @for (crumb of crumbs.trail(); track $index; let last = $last) {
                  <li>
                    @if (crumb.link && !last) {
                      <a [routerLink]="crumb.link" [class.mono]="crumb.mono">{{ crumb.label }}</a>
                    } @else {
                      <span aria-current="page" [class.mono]="crumb.mono">{{ crumb.label }}</span>
                    }
                  </li>
                }
              </ol>
            </nav>
          }
        </header>
        <main os-page id="main" tabindex="-1">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
  styles: `
    .brand {
      display: flex;
      gap: var(--os-space-2);
      align-items: center;
      padding: 0 var(--os-space-5);
      color: var(--os-fg-default);
      font-size: var(--os-text-md);
      font-weight: var(--os-font-weight-semibold);
      letter-spacing: -0.01em;
      text-decoration: none;
    }

    .brand .ring {
      fill: var(--os-fg-default);
    }

    .brand .glyph {
      fill: var(--os-brand-default);
    }

    .os-shell-sidebar {
      gap: var(--os-space-1);
    }

    .ws {
      margin-block-end: var(--os-space-3);
    }

    .ws-button {
      display: flex;
      gap: var(--os-space-2);
      align-items: center;
      inline-size: 100%;
      min-block-size: 2.75rem;
      padding: var(--os-space-2);
      border: 1px var(--os-border-style) var(--os-border-default);
      border-radius: var(--os-radius-md);
      background: var(--os-bg-surface-100);
      color: var(--os-fg-default);
      font: inherit;
      text-align: start;
      cursor: pointer;
    }

    .ws-button:hover {
      border-color: var(--os-border-strong);
    }

    .chevrons {
      margin-inline-start: auto;
      color: var(--os-fg-muted);
    }

    .ws-text {
      display: grid;
      min-inline-size: 0;
      line-height: 1.25;
    }

    .ws-text strong,
    .ws-text small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ws-text strong {
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-semibold);
    }

    .ws-text small {
      color: var(--os-fg-muted);
      font-size: var(--os-text-xs);
    }

    .badge {
      display: inline-grid;
      flex: none;
      place-items: center;
      inline-size: 1.75rem;
      block-size: 1.75rem;
      border-radius: var(--os-radius-sm);
      background: var(--os-brand-default);
      color: var(--os-brand-ink);
      font-size: 0.6875rem;
      font-weight: var(--os-font-weight-semibold);
      letter-spacing: 0.02em;
    }

    .badge.sm {
      inline-size: 1.25rem;
      block-size: 1.25rem;
      font-size: 0.5625rem;
    }

    .badge.neutral {
      background: var(--os-fg-default);
      color: var(--os-bg-default);
    }

    .ws-menu {
      min-inline-size: anchor-size(inline);
    }

    .checked {
      margin-inline-start: auto;
      color: var(--os-brand-default);
    }

    ul {
      display: grid;
      gap: 1px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    li a {
      display: flex;
      gap: var(--os-space-2);
      align-items: center;
      min-block-size: 2.25rem;
      padding-inline: var(--os-space-2);
      border-radius: var(--os-radius-sm);
      color: var(--os-fg-light);
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-medium);
      text-decoration: none;
    }

    li a svg {
      color: var(--os-fg-muted);
    }

    li a:hover {
      background: var(--os-bg-hover);
      color: var(--os-fg-default);
    }

    li a.active {
      background: var(--os-bg-surface-100);
      box-shadow: 0 0 0 1px var(--os-border-default);
      color: var(--os-fg-default);
    }

    li a.active svg {
      color: var(--os-brand-default);
    }

    .rail-foot {
      display: grid;
      gap: 1px;
      margin-block-start: auto;
      padding-block-start: var(--os-space-3);
    }

    .me-row {
      display: flex;
      gap: var(--os-space-2);
      align-items: center;
      margin-block-start: var(--os-space-2);
      padding: var(--os-space-2);
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
    }

    .avatar {
      display: grid;
      flex: none;
      place-items: center;
      inline-size: 1.75rem;
      block-size: 1.75rem;
      border-radius: var(--os-radius-full);
      background: var(--os-bg-hover);
      color: var(--os-fg-light);
      font-size: 0.6875rem;
      font-weight: var(--os-font-weight-semibold);
    }

    .me-row > span:not(.avatar) {
      display: grid;
      min-inline-size: 0;
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-medium);
      line-height: 1.3;
    }

    .me-row small {
      overflow: hidden;
      color: var(--os-fg-muted);
      font-size: var(--os-text-xs);
      font-weight: var(--os-font-weight-regular);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .me-row button {
      margin-inline-start: auto;
    }

    .external {
      margin-inline-start: auto;
    }

    .crumbs {
      min-inline-size: 0;
    }

    main:focus:not(:focus-visible) {
      outline: none;
    }
  `,
})
export class Shell {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  protected readonly crumbs = inject(Crumbs);
  protected readonly me = this.session.me;
  protected readonly team = this.session.team;
  protected readonly docsUrl = DOCS_URL;
  protected readonly menuOpen = signal(false);
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly initials = initials;
  protected readonly icons = {
    check: iconCheck,
    chevrons: iconChevrons,
    docs: iconDocs,
    external: iconExternal,
    menu: iconMenu,
    teams: iconTeams,
    settings: iconSettings,
    signOut: iconSignOut,
  };

  protected readonly links = computed(() => {
    const role = this.session.role();
    return role ? LINKS.filter((l) => l.roles.includes(role)) : [];
  });

  /** "Server admin", or the role in this team. */
  protected readonly roleLine = computed(() => {
    if (this.me()?.isServerAdmin) return 'Server admin';
    const role = this.session.role();
    return role ? ROLE_LABELS[role] : '';
  });

  constructor() {
    const sync = () => {
      const match = /^\/t\/([^/?#]+)/.exec(this.router.url);
      // Pages outside a team (Settings, Teams) keep the last one in the switch.
      if (match?.[1]) this.session.team.set(decodeURIComponent(match[1]));
      else if (!this.session.team()) {
        this.session.team.set(this.me()?.teams.at(0)?.slug ?? null);
      }
    };
    sync();
    let lastPath = this.router.url.split('?')[0];
    const sub = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        sync();
        this.menuOpen.set(false);
        // A new page (not just a new tab or filter in the query): screen readers and keyboards
        // start at its content, as they would after a full page load.
        const path = event.urlAfterRedirects.split('?')[0];
        if (path !== lastPath) {
          lastPath = path;
          document.getElementById('main')?.focus({ preventScroll: true });
        }
      }
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
    });
  }

  protected pick(slug: string): void {
    void this.router.navigate(['/t', slug, 'apps']);
  }

  protected async signOut(): Promise<void> {
    await this.session.signOut();
    await this.router.navigate(['/sign-in']);
  }
}
