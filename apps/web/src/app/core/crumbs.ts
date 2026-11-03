import { Injectable, signal } from '@angular/core';

export interface Crumb {
  label: string;
  /** Router link; the last crumb (the current page) has none. */
  link?: string[];
  /** Shown in the mono font, e.g. an environment name. */
  mono?: boolean;
}

/** The topbar's breadcrumbs, set by the page on screen: Apps › Shop › production. */
@Injectable({ providedIn: 'root' })
export class Crumbs {
  readonly trail = signal<Crumb[]>([]);
}
