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

const serverAdmin: CanActivateFn = () =>
  inject(Session).me()?.isServerAdmin ? true : inject(Router).createUrlTree(['/']);

const page = (path: string, title: string, load: Routes[number]['loadComponent']) => ({
  path,
  loadComponent: load,
  title: `${title} · OpenVersion`,
});

export const routes: Routes = [
  { path: 'sign-in', component: SignIn, title: 'Sign in · OpenVersion' },
  {
    path: '',
    component: Shell,
    canActivate: [signedIn],
    children: [
      { path: '', component: Start, title: 'OpenVersion' },
      page('settings', 'Settings', () => import('./pages/settings').then((m) => m.Settings)),
      {
        ...page('teams', 'Teams', () => import('./pages/teams').then((m) => m.Teams)),
        canActivate: [serverAdmin],
      },
      {
        path: 't/:team',
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'apps' },
          page('apps', 'Apps', () => import('./pages/apps').then((m) => m.Apps)),
          page('apps/:app/:env', 'Environment', () =>
            import('./pages/environment/environment').then((m) => m.EnvironmentPage),
          ),
          page('integrations', 'Integrations', () =>
            import('./pages/integrations').then((m) => m.Integrations),
          ),
          page('members', 'Members', () => import('./pages/members').then((m) => m.Members)),
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
