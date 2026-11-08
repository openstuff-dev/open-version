import { inject } from '@angular/core';
import { type CanActivateFn, Router, type Routes } from '@angular/router';
import { Session } from './core/session';
import { SignIn } from './pages/sign-in';
import { Start } from './pages/start';
import { Shell } from './shell';

const signedIn: CanActivateFn = async (_route, state) => {
  const session = inject(Session);
  const me = session.me() ?? (await session.load());
  return me ? true : inject(Router).createUrlTree(['/sign-in'], { queryParams: { next: state.url } });
};

const page = (path: string, title: string, load: Routes[number]['loadComponent']) => ({
  path,
  loadComponent: load,
  title: `${title} · OpenVersion`,
});

/** Settings for the team in the URL, or for the account when there isn't one. */
const settings = () => [
  { path: 'settings', pathMatch: 'full' as const, redirectTo: 'settings/account' },
  page('settings/:tab', 'Settings', () =>
    import('./pages/settings/settings').then((m) => m.SettingsPage),
  ),
];

export const routes: Routes = [
  { path: 'sign-in', component: SignIn, title: 'Sign in · OpenVersion' },
  {
    path: '',
    component: Shell,
    canActivate: [signedIn],
    children: [
      { path: '', component: Start, title: 'OpenVersion' },
      ...settings(),
      // Old addresses: the same tabs, now in Settings.
      { path: 'teams', pathMatch: 'full', redirectTo: 'settings/teams' },
      {
        path: 't/:team',
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'apps' },
          page('apps', 'Apps', () => import('./pages/apps').then((m) => m.Apps)),
          page('apps/:app/:env', 'Environment', () =>
            import('./pages/environment/environment').then((m) => m.EnvironmentPage),
          ),
          { path: 'integrations', pathMatch: 'full', redirectTo: 'settings/integrations' },
          { path: 'members', pathMatch: 'full', redirectTo: 'settings/members' },
          ...settings(),
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
