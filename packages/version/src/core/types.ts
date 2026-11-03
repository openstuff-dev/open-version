import type { RefreshPolicy } from './decide.js';

/** The answer of `GET /api/v1/version?key=pk_…`. */
export interface VersionInfo {
  /** The live release's version, or null before the first release. */
  version: string | null;
  /** The live release asks every tab to reload. */
  hard: boolean;
  /** Raised by every hard refresh. */
  epoch: number;
  policy: RefreshPolicy;
  /** When the live release was published, ISO 8601. */
  releasedAt: string | null;
  /** Where people read what changed, if the release has notes. */
  notesUrl: string | null;
}
