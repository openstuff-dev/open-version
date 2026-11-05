import { sameVersion } from './semver.js';

/** How an environment wants its tabs to get a new version. */
export type RefreshPolicy = 'prompt' | 'force';

/** What a tab should do now. */
export type Decision = 'none' | 'prompt' | 'force';

/** What `GET /api/v1/version` answers, as far as reloading goes. */
export interface LiveState {
  /** The live release's version, or null before the first release. */
  version: string | null;
  /** The live release asks every tab to reload. */
  hard: boolean;
  /** Raised by every hard refresh. */
  epoch: number;
  policy: RefreshPolicy;
}

/**
 * Should this tab reload? The one source for that question: the server, the client and the
 * tests all use it.
 *
 * @param running the version the tab was built as
 * @param seen the refresh epoch the tab saw at page load, or null on its first check
 * @param live what the version endpoint says now
 *
 * - The epoch went up since page load: `force`.
 * - The live version differs from `running` (higher **or lower**: a rollback counts too) and
 *   the release is hard or the policy is `force`: `force`. Otherwise, if it differs: `prompt`.
 * - Same version, same epoch, or nothing released yet: `none`.
 */
export function decide(running: string, seen: number | null, live: LiveState): Decision {
  if (seen !== null && live.epoch > seen) return 'force';
  if (live.version === null || sameVersion(running, live.version)) return 'none';
  return live.hard || live.policy === 'force' ? 'force' : 'prompt';
}

/** When open tabs act on a hard refresh. The dashboard and the CLI both say this. */
export const HARD_REFRESH_TIMING =
  'Visible tabs reload after their next check, about 5 minutes by default, plus a 30-second countdown. Background tabs reload when they are shown again.';
