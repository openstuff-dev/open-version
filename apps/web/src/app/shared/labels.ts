import type { ReleaseSource, Role } from '@open-version/contracts';

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  developer: 'Developer',
  viewer: 'Viewer',
};

export const SOURCE_LABELS: Record<ReleaseSource, string> = {
  cli: 'CLI',
  api: 'API',
  web: 'Dashboard',
};

/** "3 Nov 2026, 14:00" in the reader's own language and time zone. */
export function exactTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** "2 days ago", "5 minutes ago", "now". */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(0, 'second');
}

/** "~40 open tabs" from the version checks of the last 5 minutes. */
const plural = new Intl.PluralRules('en');

export function openTabs(checks: number): string {
  if (checks === 0) return 'No open tabs checked in during the last 5 minutes';
  return plural.select(checks) === 'one' ? `~${checks} open tab` : `~${checks} open tabs`;
}

/** The first line of release notes, without markdown marks or headings, for a preview. */
export function notesPreview(notes: string): string {
  // Headings like "## New" say little; the first real line says what changed.
  const line = notes
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .find(Boolean);
  return line ?? '';
}
