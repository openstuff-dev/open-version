import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { admin, baseURL } from '../playwright.config';

const unique = (name: string): string => `${name} ${Date.now()}-${test.info().parallelIndex}-${randomUUID().slice(0, 4)}`;

/** Calls the API as the signed-in page, from the app's own origin, as the app does. */
async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, {
    data,
    headers: { origin: baseURL, 'idempotency-key': randomUUID() },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** Signs in as the server admin and makes a new team, so every test starts empty. */
async function freshTeam(page: Page): Promise<{ slug: string; name: string }> {
  await post(page.request, '/api/session', admin);
  return post(page.request, '/api/teams', { name: unique('Team') });
}

async function addApp(page: Page, team: string): Promise<void> {
  await post(page.request, `/api/t/${team}/apps`, { name: unique('Shop'), baseUrl: 'https://shop.example.com' });
}

const tab = (team: string, id: string): string => `/t/${team}/settings/${id}`;

/** Records whether a skeleton ever appeared, from before the app starts. */
async function watchForSkeleton(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = (): void => {
      if (document.querySelector('os-skeleton')) (window as unknown as { sawSkeleton: boolean }).sawSkeleton = true;
    };
    new MutationObserver(seen).observe(document, { childList: true, subtree: true });
  });
}

const sawSkeleton = (page: Page): Promise<boolean> =>
  page.evaluate(() => Boolean((window as unknown as { sawSkeleton?: boolean }).sawSkeleton));

test.describe('Every Settings tab says what it is for', () => {
  test('UC-4/S1 each tab explains itself', async ({ page }) => {
    const team = await freshTeam(page);
    await page.goto(tab(team.slug, 'account'));
    const links = page.getByRole('navigation', { name: 'Settings' }).getByRole('link');
    await expect(links.first()).toBeVisible();
    const hrefs = await links.evaluateAll((all) => all.map((a) => a.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThanOrEqual(7);
    for (const href of hrefs) {
      await page.goto(href);
      const explainer = page.locator('header[os-section-header] p').first();
      await expect(explainer, href).toBeVisible();
      expect((await explainer.innerText()).split(' ').length, href).toBeGreaterThan(5);
    }
  });

  test('UC-4/S2 no release notes yet offers to add them', async ({ page }) => {
    const team = await freshTeam(page);
    await addApp(page, team.slug);
    await page.goto(tab(team.slug, 'integrations'));
    const empty = page.locator('os-empty-state', { hasText: 'No integrations yet' });
    await expect(empty).toContainText('Post each release’s notes to OpenAnnounce');
    await empty.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('dialog[open]')).toContainText('Post release notes');
  });

  test('UC-4/S3 no apps yet says to add one first', async ({ page }) => {
    const team = await freshTeam(page);
    await page.goto(tab(team.slug, 'integrations'));
    const empty = page.locator('os-empty-state', { hasText: 'No integrations yet' });
    await expect(empty).toContainText('Add an app first.');
    await empty.getByRole('link', { name: 'Apps' }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/apps$`));
  });

  test('UC-4/S4 a viewer is told who to ask, with no button', async ({ page, browser }) => {
    const team = await freshTeam(page);
    await addApp(page, team.slug);
    const viewer = { email: `${randomUUID()}@e2e.test`, name: 'Vic Viewer', role: 'viewer' };
    const { password } = await post<{ password: string }>(page.request, `/api/t/${team.slug}/members`, viewer);

    const context = await browser.newContext({ baseURL });
    const theirs = await context.newPage();
    await post(theirs.request, '/api/session', { email: viewer.email, password });
    await theirs.goto(tab(team.slug, 'integrations'));
    const empty = theirs.locator('os-empty-state', { hasText: 'No integrations yet' });
    await expect(empty).toContainText('Ask an admin');
    await expect(empty.getByRole('button')).toHaveCount(0);
    await expect(empty.getByRole('link')).toHaveCount(0);
    await context.close();
  });

  test('UC-4/S5 a slow tab shows a placeholder, a fast one does not flash', async ({ page }) => {
    const team = await freshTeam(page);
    await watchForSkeleton(page);

    await page.goto(tab(team.slug, 'members'));
    await expect(page.locator('os-empty-state')).toBeVisible();
    expect(await sawSkeleton(page)).toBe(false);

    await page.route('**/api/t/*/members', async (route) => {
      await new Promise((done) => setTimeout(done, 1500));
      await route.continue();
    });
    await page.reload();
    await expect(page.locator('os-skeleton')).toBeVisible();
    await expect(page.locator('os-empty-state')).toBeVisible();
    await expect(page.locator('os-skeleton')).toBeHidden();
  });

  test('UC-4/S6 a tab that cannot load says what failed', async ({ page }) => {
    const team = await freshTeam(page);
    await page.route('**/api/t/*/{members,integrations}', (route) =>
      route.fulfill({ status: 503, json: { error: 'The server is down for a moment.' } }),
    );
    await page.goto(tab(team.slug, 'members'));
    await expect(page.locator('os-callout[tone=danger]')).toContainText('The members didn’t load');
    await page.goto(tab(team.slug, 'integrations'));
    await expect(page.locator('os-callout[tone=danger]')).toContainText('The integrations didn’t load');
  });

  test('UC-4/S7 removing a member or deleting a team says what stops and what stays', async ({ page }) => {
    const team = await freshTeam(page);
    await post(page.request, `/api/t/${team.slug}/members`, {
      email: `${randomUUID()}@e2e.test`,
      name: 'Dev Developer',
      role: 'developer',
    });
    const dialog = page.locator('os-confirm-dialog dialog');

    await page.goto(tab(team.slug, 'members'));
    await page.getByRole('row', { name: /Dev Developer/ }).getByRole('button', { name: /Remove/ }).click();
    await expect(dialog).toContainText('lose access');
    await expect(dialog).toContainText('Their account stays');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await page.goto(tab(team.slug, 'teams'));
    await page.getByRole('button', { name: `Delete ${team.name}` }).click();
    await expect(dialog).toContainText('stop hearing about new versions');
    await expect(dialog).toContainText('Member accounts stay');
    await dialog.getByRole('button', { name: 'Delete team' }).click();
    await expect(page).toHaveURL(/\/settings\/teams$/);
    await expect(page.getByRole('link', { name: team.name })).toHaveCount(0);
  });
});
