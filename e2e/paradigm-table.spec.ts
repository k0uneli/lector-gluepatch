import { test, expect, Page } from '@playwright/test';

/**
 * The declension / conjugation table button in the word definition drawer.
 *
 * The e2e data has no dictionaries, so /api/dictionary/lookup and
 * /api/dictionary/paradigm are mocked. The table builder is covered by
 * languages/paradigm.test.ts and api/src/routes/dictionary-paradigm.test.ts.
 *
 * Covers:
 *   - Happy path: open the drawer, open the table, close it; the looked-up form is marked
 *   - A verb shows each tense table and the other forms
 *   - No button when the word has no table, or the lookup missed
 *   - Escape closes the table and leaves the drawer open
 */

const NOUN = {
  lemma: 'kat',
  kind: 'noun',
  tables: [
    {
      title: '',
      columns: ['singular', 'plural'],
      rows: [
        {
          label: 'nominative',
          cells: [
            { tags: ['nominative', 'singular'], forms: ['kat'] },
            { tags: ['nominative', 'plural'], forms: ['katte'] },
          ],
        },
        {
          label: 'genitive',
          cells: [
            { tags: ['genitive', 'singular'], forms: [] },
            { tags: ['genitive', 'plural'], forms: ['katte'] },
          ],
        },
      ],
    },
  ],
  other: [],
};

const VERB = {
  lemma: 'lees',
  kind: 'verb',
  tables: [
    {
      title: 'Present',
      columns: ['singular', 'plural'],
      rows: [
        {
          label: '1st person',
          cells: [
            { tags: ['present', 'first-person', 'singular'], forms: ['lees'] },
            { tags: ['present', 'first-person', 'plural'], forms: ['lees'] },
          ],
        },
      ],
    },
    {
      title: 'Past',
      columns: [''],
      rows: [{ label: 'masculine', cells: [{ tags: ['past'], forms: ['gelees'] }] }],
    },
  ],
  other: [{ label: 'present active participle', forms: ['lesende'] }],
};

async function mockDictionary(page: Page, paradigm: unknown, { hit = true } = {}) {
  const paradigmRequests: string[] = [];
  await page.route('**/api/dictionary/lookup**', async (route) => {
    const word = new URL(route.request().url()).searchParams.get('word') || 'word';
    await route.fulfill({
      json: {
        entry: hit ? { word, senses: [{ partOfSpeech: 'noun', gloss: 'test definition' }] } : null,
      },
    });
  });
  await page.route('**/api/dictionary/paradigm**', async (route) => {
    paradigmRequests.push(new URL(route.request().url()).searchParams.get('word') ?? '');
    await route.fulfill({ json: { paradigm } });
  });
  return paradigmRequests;
}

async function openFirstWord(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/practice');
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: '10', exact: true }).click();
  await page.getByRole('button', { name: 'Type' }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Fill in the blank')).toBeVisible({ timeout: 10000 });
  const word = page.getByTestId('cloze-word').first();
  const text = (await word.textContent())?.trim() ?? '';
  await word.click();
  await expect(page.getByTestId('translation-drawer')).toContainText('test definition');
  return text;
}

test.describe('Declension and conjugation table', () => {
  test('opens from the drawer and closes again', async ({ page }) => {
    const requests = await mockDictionary(page, NOUN);
    const word = await openFirstWord(page);

    const button = page.getByTestId('paradigm-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName('Declension table');
    expect(requests).toContain(word.replace(/[.,!?;:]+$/, ''));

    await button.click();
    const dialog = page.getByTestId('paradigm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText('Declension of kat');
    await expect(dialog.getByRole('columnheader', { name: 'plural' })).toBeVisible();
    await expect(dialog.getByRole('rowheader', { name: 'genitive' })).toBeVisible();
    await expect(dialog.getByLabel('not listed')).toHaveCount(1);

    await dialog.getByRole('button', { name: 'Close table' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('translation-drawer')).toContainText('test definition');
  });

  test('highlights the cell that holds the word', async ({ page }) => {
    await page.route('**/api/dictionary/paradigm**', async (route) => {
      const word = new URL(route.request().url()).searchParams.get('word') ?? '';
      const table = structuredClone(NOUN);
      table.tables[0].rows[1].cells[0].forms = [word];
      await route.fulfill({ json: { paradigm: table } });
    });
    await page.route('**/api/dictionary/lookup**', async (route) => {
      const word = new URL(route.request().url()).searchParams.get('word') || 'word';
      await route.fulfill({
        json: { entry: { word, senses: [{ partOfSpeech: 'noun', gloss: 'test definition' }] } },
      });
    });
    await openFirstWord(page);
    await page.getByTestId('paradigm-button').click();
    const marked = page.getByTestId('paradigm-dialog').locator('[data-highlight]');
    await expect(marked).toHaveCount(1);
  });

  test('a verb shows each tense and its other forms', async ({ page }) => {
    await mockDictionary(page, VERB);
    await openFirstWord(page);
    await page.getByTestId('paradigm-button').click();
    const dialog = page.getByTestId('paradigm-dialog');
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Conjugation of lees');
    await expect(dialog.getByRole('heading', { name: 'Present' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Past' })).toBeVisible();
    await expect(dialog.getByText('present active participle')).toBeVisible();
    await expect(dialog.getByText('lesende')).toBeVisible();
  });

  test('no button when the word has no table', async ({ page }) => {
    const requests = await mockDictionary(page, null);
    await openFirstWord(page);
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    await expect(page.getByTestId('paradigm-button')).toHaveCount(0);
  });

  test('no table request when the dictionary missed', async ({ page }) => {
    const requests = await mockDictionary(page, NOUN, { hit: false });
    await page.route('**/api/translate**', (route) =>
      route.fulfill({ json: { translation: 'ai gloss', partOfSpeech: 'noun' } }),
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/practice');
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: '10', exact: true }).click();
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByText('Fill in the blank')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('cloze-word').first().click();
    await expect(page.getByTestId('translation-drawer')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('paradigm-button')).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test('Escape closes the table and keeps the drawer open', async ({ page }) => {
    await mockDictionary(page, NOUN);
    await openFirstWord(page);
    await page.getByTestId('paradigm-button').click();
    await expect(page.getByTestId('paradigm-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('paradigm-dialog')).toHaveCount(0);
    await expect(page.getByTestId('translation-drawer')).toContainText('test definition');
    await expect(page.getByTestId('paradigm-button')).toBeVisible();
  });
});
