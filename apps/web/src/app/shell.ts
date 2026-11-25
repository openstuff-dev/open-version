import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { Role } from '@open-version/contracts';
import {
  Breadcrumbs,
  Icon,
  IconButton,
  IdentityBadge,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  NavLink as OsNavLink,
  Page,
  PopoverTrigger,
  ShellFooter,
  ShellSwitcher,
  ShellSwitcherButton,
  ShellUser,
  initials,
} from '@openstuff-dev/ui-angular';
import { Crumbs } from './core/crumbs';
import { Session } from './core/session';
import {
  iconApps,
  iconCheck,
  iconDocs,
  iconExternal,
  iconMenu,
  iconSettings,
  iconSignOut,
  iconTeams,
} from './shared/icons';
import { ROLE_LABELS } from './shared/labels';

export { initials };

type IconNode = typeof iconApps;
interface NavItem {
  path: string;
  label: string;
  icon: IconNode;
  roles: readonly Role[];
}

/** The pages in the sidebar, and who sees each. */
const LINKS: NavItem[] = [
  { path: 'apps', label: 'Apps', icon: iconApps, roles: ['admin', 'developer', 'viewer'] },
];

/** Where the Docs link goes: how to add the client and publish from CI. */
export const DOCS_URL = 'https://github.com/openstuff-dev/open-version#readme';

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
    IdentityBadge,
    Menu,
    MenuItem,
    MenuLabel,
    MenuSeparator,
    OsNavLink,
    Page,
    PopoverTrigger,
    ShellFooter,
    ShellSwitcher,
    ShellSwitcherButton,
    ShellUser,
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
            <div os-shell-switcher>
              <button type="button" os-shell-switcher-button [os-popover-trigger]="wsMenu">
                @if (session.membership(); as current) {
                  <span os-identity-badge aria-hidden="true">{{ initials(current.name) }}</span>
                  <span class="os-shell-switcher-text">
                    <strong>{{ current.name }}</strong>
                    <small>{{ roleLabels[current.role] }}</small>
                  </span>
                } @else {
                  <span os-identity-badge neutral aria-hidden="true">?</span>
                  <span class="os-shell-switcher-text">
                    <strong>Choose a team</strong>
                    <small>{{ me.teams.length }} available</small>
                  </span>
                }
              </button>
              <div
                os-menu
                #wsMenu="osPopover"
                class="os-shell-switcher-menu"
                aria-label="Switch team"
              >
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
                      <span os-identity-badge size="sm" aria-hidden="true">{{
                        initials(t.name)
                      }}</span>
                      {{ t.name }}
                      @if (t.slug === team()) {
                        <svg os-icon [icon]="icons.check" size="sm"></svg>
                      }
                    </button>
                  }
                }
                @if (me.isServerAdmin) {
                  <hr os-menu-separator />
                  <a os-menu-item routerLink="/settings/teams">
                    <svg os-icon [icon]="icons.teams" size="sm"></svg>Manage teams
                  </a>
                }
              </div>
            </div>
          }
        }

        @if (team(); as t) {
          @for (link of links(); track link.path) {
            <a
              os-nav-link
              [routerLink]="['/t', t, link.path]"
              routerLinkActive
              ariaCurrentWhenActive="page"
              [icon]="link.icon"
              >{{ link.label }}</a
            >
          }
          <a os-nav-link [href]="docsUrl" target="_blank" rel="noopener" [icon]="icons.docs">
            Docs
            <svg os-icon [icon]="icons.external" size="sm" class="external"></svg>
            <span class="os-visually-hidden">(opens in a new tab)</span>
          </a>
        }

        <div os-shell-footer>
          <a
            os-nav-link
            [routerLink]="settingsLink()"
            routerLinkActive
            ariaCurrentWhenActive="page"
            [icon]="icons.settings"
            >Settings</a
          >
          @if (me(); as me) {
            <div os-shell-user [name]="me.name || me.email" [role]="roleLine()">
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
    .brand .ring {
      fill: var(--os-fg-default);
    }

    .brand .glyph {
      fill: var(--os-brand-default);
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
    docs: iconDocs,
    external: iconExternal,
    menu: iconMenu,
    teams: iconTeams,
    settings: iconSettings,
    signOut: iconSignOut,
  };

  /** Settings inside the team in view, so its tabs show; otherwise the account-level ones. */
  protected readonly settingsLink = computed(() => {
    const team = this.session.team();
    return team ? ['/t', team, 'settings'] : ['/settings'];
  });

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
