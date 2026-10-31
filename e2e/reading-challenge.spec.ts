import { test, expect, Page, Route } from '@playwright/test';
import { apiUrl } from './api';

/**
 * The daily reading challenge page (/reading) and its settings.
 *
 * The browser's /api/reading-challenge calls are served by a stateful mock,
 * because the e2e API has no language model. Generation, coverage and lesson
 * storage are covered by api/src/routes/reading-challenge.test.ts.
 *
 * Covers:
 *   - Happy path: nav link, start, the challenge card, new words, the reader link
 *   - Too few marked words, and a failed generation with retry
 *   - Resuming a started challenge
 *   - The settings sliders reaching the request
 */

const CHALLENGE = {
  day: '2026-10-31',
  lessonId: 'lesson-reading-1',
  collectionId: 'collection-reading',
  title: 'Die kat in die huis',
  wordCount: 212,
  targetNewPercent: 5,
  newPercent: 4.7,
  newWords: ['spens', 'snuif'],
  progress: 0,
};

interface MockOptions {
  startError?: { status: number; body: unknown } | null;
  challenge?: typeof CHALLENGE | null;
}

/** Serve /api/reading-challenge from memory. Returns the POST bodies it saw. */
async function mockReading(page: Page, options: MockOptions = {}) {
  const state = { challenge: options.challenge ?? null, startError: options.startError ?? null };
  const starts: unknown[] = [];
  await page.route('**/api/reading-challenge/**', async (route: Route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      starts.push(JSON.parse(request.postData() ?? '{}'));
      if (state.startError) {
        const { status, body } = state.startError;
        state.startError = null;
        await route.fulfill({ status, json: body });
        return;
      }
      state.challenge = CHALLENGE;
    }
    await route.fulfill({ json: { day: CHALLENGE.day, challenge: state.challenge } });
  });
  return starts;
}

test.describe('Daily reading challenge', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('happy path: open from the nav, write the text, see it, open the reader', async ({
    page,
  }) => {
    const starts = await mockReading(page);
    await page.goto('/practice');
    await page.locator('aside').getByRole('link', { name: 'Daily Reading' }).click();
    await expect(page).toHaveURL(/\/reading$/);
    await expect(page.getByRole('heading', { name: 'Daily Reading' })).toBeVisible();
    await expect(page.getByTestId('reading-intro')).toContainText('about 200 words');
    await expect(page.getByTestId('reading-intro')).toContainText('About 5%');

    await page.getByTestId('reading-start').click();
    expect(starts).toEqual([{ words: 200, newPercent: 5 }]);

    await expect(page.getByTestId('reading-title')).toHaveText('Die kat in die huis');
    await expect(page.getByTestId('reading-word-count')).toHaveText('212');
    await expect(page.getByTestId('reading-new-percent')).toHaveText('4.7%');
    await expect(page.getByTestId('reading-challenge')).toContainText('target 5%');
    await expect(page.getByTestId('reading-progress')).toHaveText('0%');

    await expect(page.getByTestId('reading-new-words')).toHaveCount(0);
    await page.getByTestId('reading-toggle-new-words').click();
    await expect(page.getByTestId('reading-new-words')).toHaveText('spens, snuif');
    await expect(page.getByTestId('reading-toggle-new-words')).toHaveText('Hide new words');

    const open = page.getByTestId('reading-open');
    await expect(open).toHaveText('Start reading');
    await expect(open).toHaveAttribute('href', '/read/lesson-reading-1');
  });

  test('a started challenge loads without writing a new one', async ({ page }) => {
    const starts = await mockReading(page, { challenge: { ...CHALLENGE, progress: 42.4 } });
    await page.goto('/reading');
    await expect(page.getByTestId('reading-progress')).toHaveText('42%');
    await expect(page.getByTestId('reading-open')).toHaveText('Continue reading');
    expect(starts).toEqual([]);
  });

  test('a text with no new words hides the toggle', async ({ page }) => {
    await mockReading(page, { challenge: { ...CHALLENGE, newWords: [], newPercent: 0 } });
    await page.goto('/reading');
    await expect(page.getByTestId('reading-new-percent')).toHaveText('0%');
    await expect(page.getByTestId('reading-toggle-new-words')).toHaveCount(0);
  });

  test('too few marked words explains why and offers no start button', async ({ page }) => {
    await mockReading(page, {
      startError: {
        status: 400,
        body: { error: 'Mark at least 30 words', code: 'NOT_ENOUGH_VOCAB' },
      },
    });
    await page.goto('/reading');
    await page.getByTestId('reading-start').click();
    await expect(page.getByTestId('reading-error')).toHaveText('Mark at least 30 words');
    await expect(page.getByTestId('reading-start')).toHaveCount(0);
  });

  test('a failed generation can be retried', async ({ page }) => {
    await mockReading(page, {
      startError: { status: 502, body: { error: 'Could not write today’s text.' } },
    });
    await page.goto('/reading');
    await page.getByTestId('reading-start').click();
    await expect(page.getByTestId('reading-error')).toHaveText('Could not write today’s text.');
    await expect(page.getByTestId('reading-start')).toHaveText('Try again');
    await page.getByTestId('reading-start').click();
    await expect(page.getByTestId('reading-title')).toHaveText('Die kat in die huis');
  });

  test('the settings sliders are stored and reach the request', async ({ page }) => {
    const starts = await mockReading(page);
    await page.goto('/settings');
    await expect(page.getByTestId('reading-new-percent-value')).toHaveText('5%');
    await expect(page.getByTestId('reading-words-value')).toHaveText('200 words');

    await page.getByTestId('reading-new-percent-slider').getByRole('slider').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('reading-new-percent-value')).toHaveText('7%');

    await page.getByTestId('reading-words-slider').getByRole('slider').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('reading-words-value')).toHaveText('150 words');
    await page.keyboard.press('End');
    await expect(page.getByTestId('reading-words-value')).toHaveText('600 words');

    expect(
      await page.evaluate(() => [
        localStorage.getItem('lector-reading-challenge-new-percent'),
        localStorage.getItem('lector-reading-challenge-words'),
      ]),
    ).toEqual(['7', '600']);

    await page.goto('/reading');
    await expect(page.getByTestId('reading-intro')).toContainText('about 600 words');
    await page.getByTestId('reading-start').click();
    await expect(page.getByTestId('reading-title')).toBeVisible();
    expect(starts).toEqual([{ words: 600, newPercent: 7 }]);
  });

  test('the mobile bottom bar shows the short label', async ({ page }) => {
    await mockReading(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/reading');
    const bottomBar = page.locator('nav.fixed');
    await expect(bottomBar.getByRole('link', { name: 'Reading', exact: true })).toBeVisible();
  });

  test('the real API starts each day empty', async ({ page }) => {
    const res = await page.request.get(apiUrl('/api/reading-challenge/today?language=af'));
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.challenge).toBeNull();
  });
});
