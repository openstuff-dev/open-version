import { readFileSync } from 'node:fs';
import { HARD_REFRESH_TIMING } from '@open-version/contracts';
import { describe, expect, it } from 'vitest';

describe('hard refresh wording', () => {
  it('UC-8/S1 tells the dashboard what really happens to visible and background tabs', () => {
    const tab = readFileSync(
      new URL('../../web/src/app/pages/environment/overview-tab.ts', import.meta.url),
      'utf8',
    );
    expect(tab).toContain('${HARD_REFRESH_TIMING}');
    expect(tab).not.toContain('within 5 minutes');
    expect(HARD_REFRESH_TIMING).toContain('about 5 minutes by default, plus a 30-second countdown');
    expect(HARD_REFRESH_TIMING).toContain('Background tabs reload when they are shown again');
  });
});
