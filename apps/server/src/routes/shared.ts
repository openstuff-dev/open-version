import { z } from 'zod';
import { isVersion } from '@open-version/contracts';

export const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use lowercase letters, digits and dashes.');
export const name = z.string().trim().min(1, 'Give it a name.').max(120);
export const uuid = z.uuid();
export const teamParam = z.object({ team: slug });
export const idParam = z.object({ team: slug, id: uuid });

/** An environment name: `production`, `staging`, `preview-2`. */
export const environmentName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and dashes, like staging.');

export const version = z
  .string()
  .trim()
  .max(100)
  .refine(isVersion, 'Use a version like 1.4.2 or 1.5.0-rc.1.')
  .transform((v) => v.replace(/^v/, ''));

export const notes = z.string().max(20_000, 'Keep release notes under 20,000 characters.');

/** An http(s) URL, without a trailing slash. */
export const baseUrl = z
  .string()
  .trim()
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href.replace(/\/$/, '');
    } catch {
      // Falls through to the issue below.
    }
    ctx.addIssue({ code: 'custom', message: `"${value}" isn’t a URL like https://shop.example.com.` });
    return z.NEVER;
  });

export const origin = z
  .string()
  .trim()
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      // Falls through to the issue below.
    }
    ctx.addIssue({ code: 'custom', message: `"${value}" isn’t an origin like https://app.example.com.` });
    return z.NEVER;
  });

/** A slug from a name: "Back Office" → "back-office". */
export function slugify(text: string): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return s || 'app';
}
