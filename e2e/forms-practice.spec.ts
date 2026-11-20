import { test, expect, Page, Route } from '@playwright/test';
import { apiUrl } from './api';
import { switchLanguage } from './language-helpers';
import {
  clearRecognizer,
  FAKE_MICROPHONE,
  startRecognizerStub,
  sttUnreachable,
  useRecognizer,
} from './stt-helpers';

/**
 * The Forms practice format: a base form plus a case or tense, answered by
 * typing. /api/forms/round is mocked because the e2e data has no Russian
 * dictionary; the server side is covered by api/src/routes/forms.test.ts.
 *
 * Covers:
 *   - Happy path: choose nouns and verbs, a correct answer, a wrong one with
 *     the full table, then the summary
 *   - ё typed as е counts with a spelling note; Show answer
 *   - Speaking the form through the real STT stream with a stub recognizer
 *   - At least one word type must be chosen; settings persist
 *   - A round that cannot be built shows the server's message
 *   - The format is hidden for a language without the drill
 */

const table = (lemma: string, genPl: string) => ({
  lemma,
  kind: 'noun',
  partsOfSpeech: ['noun'],
  tables: [
    {
      title: '',
      columns: ['singular', 'plural'],
      rows: [
        {
          label: 'nominative',
          cells: [
            { tags: ['nominative', 'singular'], forms: [lemma] },
            { tags: ['nominative', 'plural'], forms: [] },
          ],
        },
        {
          label: 'genitive',
          cells: [
            { tags: ['genitive', 'singular'], forms: [] },
            { tags: ['genitive', 'plural'], forms: [genPl] },
          ],
        },
      ],
    },
  ],
  other: [],
});

const ITEMS = [
  {
    lemma: 'книга',
    gloss: 'book',
    kind: 'noun',
    tags: ['genitive', 'plural'],
    prompt: 'genitive plural',
    answers: ['книг'],
    paradigm: table('книга', 'книг'),
  },
  {
    lemma: 'читать',
    gloss: 'to read',
    kind: 'verb',
    tags: ['present', 'first-person', 'singular'],
    prompt: 'first-person singular present',
    answers: ['читаю'],
    paradigm: table('читать', 'читаю'),
  },
  {
    lemma: 'день',
    gloss: 'day',
    kind: 'noun',
    tags: ['instrumental', 'singular'],
    prompt: 'instrumental singular',
    answers: ['днём'],
    paradigm: table('день', 'днём'),
  },
];

async function mockForms(page: Page, options: { error?: { status: number; body: unknown } } = {}) {
  const seen = { rounds: [] as URLSearchParams[], answers: 0 };
  await page.route('**/api/forms/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/answer')) {
      seen.answers++;
      await route.fulfill({ json: { success: true } });
      return;
    }
    seen.rounds.push(url.searchParams);
    if (options.error) {
      await route.fulfill({ status: options.error.status, json: options.error.body });
      return;
    }
    await route.fulfill({ json: { items: ITEMS } });
  });
  return seen;
}

async function openForms(page: Page) {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Forms', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forms Practice' })).toBeVisible();
}

test.use(FAKE_MICROPHONE);

test.describe.serial('Forms practice', () => {
  test.beforeEach(async ({ page }) => {
    await switchLanguage(page, 'ru', 'Русский');
  });

  test.afterEach(async ({ page }) => {
    await page.request.put(apiUrl('/api/settings/targetLanguage'), { data: { value: 'af' } });
  });

  test('happy path: answer, see the table, finish the round', async ({ page }) => {
    const seen = await mockForms(page);
    await openForms(page);
    await page.getByTestId('forms-kind-verb').check();
    await page.getByTestId('forms-start').click();

    expect(seen.rounds[0].get('kinds')).toBe('noun,verb');
    expect(seen.rounds[0].get('count')).toBe('10');
    expect(seen.rounds[0].get('language')).toBe('ru');

    await expect(page.getByTestId('forms-progress')).toHaveText('1 of 3');
    await expect(page.getByTestId('forms-lemma')).toHaveText('книга');
    await expect(page.getByTestId('forms-gloss')).toHaveText('book');
    await expect(page.getByTestId('forms-prompt')).toHaveText('genitive plural');

    await page.getByTestId('forms-input').fill('Книг');
    await page.getByTestId('forms-input').press('Enter');
    await expect(page.getByTestId('forms-verdict')).toHaveText('Correct');
    await page.getByTestId('forms-next').click();

    await expect(page.getByTestId('forms-lemma')).toHaveText('читать');
    await page.getByTestId('forms-input').fill('читаешь');
    await page.getByTestId('forms-check').click();
    await expect(page.getByTestId('forms-verdict')).toHaveText('Not quite');
    await expect(page.getByTestId('forms-answer')).toHaveText('читаю');
    await page.getByTestId('forms-toggle-table').click();
    await expect(page.getByTestId('paradigm-tables')).toBeVisible();
    await expect(page.locator('[data-highlight]')).toHaveText('читаю');
    await page.getByTestId('forms-next').click();

    await page.getByTestId('forms-input').fill('днем');
    await page.getByTestId('forms-input').press('Enter');
    await expect(page.getByTestId('forms-verdict')).toHaveText('Correct, but check the spelling');
    await expect(page.getByTestId('forms-next')).toHaveText('See results');
    await page.getByTestId('forms-next').click();

    await expect(page.getByTestId('forms-score')).toHaveText('2/3');
    await expect(page.getByTestId('forms-summary')).toContainText('читаю');
    expect(seen.answers).toBe(3);
  });

  test('Show answer reveals the form', async ({ page }) => {
    await mockForms(page);
    await openForms(page);
    await page.getByTestId('forms-start').click();
    await expect(page.getByTestId('forms-check')).toBeDisabled();
    await page.getByTestId('forms-reveal').click();
    await expect(page.getByTestId('forms-verdict')).toHaveText('Answer shown');
    await expect(page.getByTestId('forms-answer')).toHaveText('книг');
  });

  test('a spoken form is graded when the recognizer finishes', async ({ page }) => {
    test.skip(sttUnreachable, 'the containerised API cannot reach the host stub recognizer');
    const stub = await startRecognizerStub();
    try {
      await useRecognizer(page, stub.url);
      const seen = await mockForms(page);
      await openForms(page);
      await page.getByTestId('forms-mode-voice').click();
      await page.getByTestId('forms-start').click();

      stub.say(['книг']);
      await page.getByTestId('forms-mic').click();
      await expect(page.getByTestId('forms-transcript')).toHaveText('книг', { timeout: 10000 });
      await page.getByRole('button', { name: 'Stop listening' }).click();
      await expect(page.getByTestId('forms-verdict')).toHaveText('Correct', { timeout: 10000 });
      await page.getByTestId('forms-next').click();

      stub.say(['читает']);
      await page.getByTestId('forms-mic').click();
      await expect(page.getByTestId('forms-transcript')).toHaveText('читает', { timeout: 10000 });
      await page.getByRole('button', { name: 'Stop listening' }).click();
      await expect(page.getByTestId('forms-verdict')).toHaveText('Not quite', { timeout: 10000 });
      expect(seen.answers).toBe(2);
    } finally {
      await clearRecognizer(page);
      await stub.close();
    }
  });

  test('a word type is required and the choices persist', async ({ page }) => {
    await mockForms(page);
    await openForms(page);
    await page.getByTestId('forms-kind-noun').uncheck();
    await expect(page.getByTestId('forms-start')).toBeDisabled();
    await page.getByTestId('forms-kind-verb').check();
    await page.getByTestId('forms-count-20').click();

    await page.reload();
    await page.getByRole('button', { name: 'Forms', exact: true }).click();
    await expect(page.getByTestId('forms-kind-verb')).toBeChecked();
    await expect(page.getByTestId('forms-kind-noun')).not.toBeChecked();
    expect(
      await page.evaluate(() => [
        localStorage.getItem('lector-forms-kinds'),
        localStorage.getItem('lector-forms-count'),
      ]),
    ).toEqual(['verb', '20']);
  });

  test('a round that cannot be built shows why', async ({ page }) => {
    await mockForms(page, {
      error: {
        status: 404,
        body: { error: 'No noun tables found.', code: 'NO_ITEMS' },
      },
    });
    await openForms(page);
    await page.getByTestId('forms-start').click();
    await expect(page.getByTestId('forms-error')).toHaveText('No noun tables found.');
    await expect(page.getByTestId('forms-start')).toBeEnabled();
  });
});

test('the Forms format is hidden for a language without the drill', async ({ page }) => {
  await page.request.put(apiUrl('/api/settings/targetLanguage'), { data: { value: 'af' } });
  await page.goto('/practice');
  await expect(page.getByRole('button', { name: 'Recall', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forms', exact: true })).toHaveCount(0);
});
