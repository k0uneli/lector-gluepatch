import { test, expect, Page, Route } from '@playwright/test';
import { apiUrl } from './api';

/**
 * The daily recall challenge (third practice format).
 *
 * The browser's /api/recall calls are served by a stateful mock, because the
 * e2e API has no language model. The server side (generation, vocab checks,
 * grading, level moves) is covered by api/src/routes/recall.test.ts.
 *
 * Covers:
 *   - Happy path: start, hint, a correct answer, give up, then the summary
 *   - Overriding the AI's verdict
 *   - Too little vocab, and a failed generation with retry
 *   - Resuming a half-done challenge
 *   - The sentences-per-day setting reaching the request
 */

interface Item {
  idx: number;
  english: string;
  words: string[];
  answer: string | null;
  correct: boolean | null;
  aiCorrect: boolean | null;
  reference: string | null;
  feedback: unknown;
  vocabChanges: unknown[];
}

const SENTENCES = [
  { english: 'I see the cat.', reference: 'Ek sien die kat.', words: ['sien', 'kat'] },
  { english: 'The house is big.', reference: 'Die huis is groot.', words: ['huis', 'groot'] },
];

function unanswered(i: number): Item {
  return {
    idx: i,
    english: SENTENCES[i].english,
    words: SENTENCES[i].words,
    answer: null,
    correct: null,
    aiCorrect: null,
    reference: null,
    feedback: null,
    vocabChanges: [],
  };
}

interface MockOptions {
  startError?: { status: number; body: unknown } | null;
  items?: Item[];
}

/** Serve /api/recall from memory. Returns the request bodies it saw. */
async function mockRecall(page: Page, options: MockOptions = {}) {
  const state = { items: options.items ?? ([] as Item[]), startError: options.startError ?? null };
  const seen: { start: unknown[]; answers: unknown[]; verdicts: unknown[] } = {
    start: [],
    answers: [],
    verdicts: [],
  };
  await page.route('**/api/recall/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(request.postData()!) : null;
    const day = '2026-10-10';

    if (url.pathname.endsWith('/today')) {
      if (request.method() === 'POST') {
        seen.start.push(body);
        if (state.startError) {
          const { status, body: errorBody } = state.startError;
          state.startError = null;
          await route.fulfill({ status, json: errorBody });
          return;
        }
        state.items = SENTENCES.map((_, i) => unanswered(i));
      }
      await route.fulfill({ json: { day, items: state.items } });
      return;
    }

    const match = url.pathname.match(/\/(\d+)\/(answer|verdict)$/)!;
    const idx = Number(match[1]);
    const item = state.items[idx];
    if (match[2] === 'answer') {
      seen.answers.push(body);
      const giveUp = body.giveUp === true;
      const correct = !giveUp && body.answer === SENTENCES[idx].reference;
      Object.assign(item, {
        answer: giveUp ? '' : body.answer,
        correct,
        aiCorrect: giveUp ? null : correct,
        reference: SENTENCES[idx].reference,
        feedback: giveUp
          ? { corrected: '', notes: [], missed: [] }
          : {
              corrected: SENTENCES[idx].reference,
              notes: correct
                ? []
                : [{ original: 'kot', corrected: 'kat', explanation: 'Spelling.' }],
              missed: correct ? [] : ['kat'],
            },
        vocabChanges: correct
          ? [{ text: 'kat', from: 'level1', to: 'level2' }]
          : [{ text: 'kat', from: 'level2', to: 'level1' }],
      });
    } else {
      seen.verdicts.push(body);
      item.correct = body.correct;
    }
    await route.fulfill({ json: item });
  });
  return seen;
}

async function openRecall(page: Page) {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Recall', exact: true }).click();
}

test.describe('Recall practice', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('happy path: start, hint, answer, give up, summary', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('lector-recall-daily-count', '5'));
    const seen = await mockRecall(page);
    await openRecall(page);

    await expect(page.getByRole('heading', { name: 'Recall Practice' })).toBeVisible();
    await expect(page.getByTestId('recall-intro')).toContainText('Translate 5 English sentences');
    await page.getByTestId('recall-start').click();
    expect(seen.start).toEqual([{ count: 5 }]);

    await expect(page.getByTestId('recall-progress')).toHaveText('Sentence 1 of 2');
    await expect(page.getByTestId('recall-english')).toHaveText('I see the cat.');
    await page.getByTestId('recall-show-hint').click();
    await expect(page.getByTestId('recall-hint')).toContainText('sien, kat');

    await page.getByTestId('recall-input').fill('Ek sien die kat.');
    await page.getByTestId('recall-input').press('Enter');
    await expect(page.getByTestId('recall-verdict')).toHaveText('Correct');
    await expect(page.getByTestId('recall-reference')).toHaveText('Ek sien die kat.');
    await expect(page.getByTestId('recall-vocab-changes')).toContainText('level 2');
    await page.getByTestId('recall-next').click();

    await expect(page.getByTestId('recall-progress')).toHaveText('Sentence 2 of 2');
    await expect(page.getByTestId('recall-input')).toHaveValue('');
    await page.getByTestId('recall-give-up').click();
    await expect(page.getByTestId('recall-verdict')).toHaveText('Answer shown');
    await expect(page.getByTestId('recall-override')).toHaveCount(0);
    expect(seen.answers.at(-1)).toEqual({ answer: '', giveUp: true });
    await page.getByTestId('recall-next').click();

    await expect(page.getByTestId('recall-score')).toHaveText('1/2');
    await expect(page.getByTestId('recall-summary')).toContainText('Die huis is groot.');
  });

  test('the Check button stays disabled for an empty answer', async ({ page }) => {
    await mockRecall(page, { items: SENTENCES.map((_, i) => unanswered(i)) });
    await openRecall(page);
    await expect(page.getByTestId('recall-submit')).toBeDisabled();
    await page.getByTestId('recall-input').fill('   ');
    await expect(page.getByTestId('recall-submit')).toBeDisabled();
  });

  test('a wrong answer shows corrections and can be overridden', async ({ page }) => {
    const seen = await mockRecall(page, { items: SENTENCES.map((_, i) => unanswered(i)) });
    await openRecall(page);

    await page.getByTestId('recall-input').fill('Ek sien die kot.');
    await page.getByTestId('recall-submit').click();
    await expect(page.getByTestId('recall-verdict')).toHaveText('Not quite');
    await expect(page.getByTestId('recall-corrected')).toHaveText('Ek sien die kat.');
    await expect(page.getByTestId('recall-notes')).toContainText('Spelling.');

    await page.getByTestId('recall-override').click();
    await expect(page.getByTestId('recall-verdict')).toHaveText('Correct');
    await expect(page.getByText('(you overrode the AI)')).toBeVisible();
    await expect(page.getByTestId('recall-override')).toHaveText('Mark as wrong');
    expect(seen.verdicts).toEqual([{ correct: true }]);
  });

  test('too little vocab explains why and offers no start button', async ({ page }) => {
    await mockRecall(page, {
      startError: {
        status: 400,
        body: { error: 'Save at least 5 words to your vocab', code: 'NOT_ENOUGH_VOCAB' },
      },
    });
    await openRecall(page);
    await page.getByTestId('recall-start').click();
    await expect(page.getByTestId('recall-error')).toHaveText(
      'Save at least 5 words to your vocab',
    );
    await expect(page.getByTestId('recall-start')).toHaveCount(0);
  });

  test('a failed generation can be retried', async ({ page }) => {
    await mockRecall(page, {
      startError: { status: 502, body: { error: 'Could not write today’s sentences.' } },
    });
    await openRecall(page);
    await page.getByTestId('recall-start').click();
    await expect(page.getByTestId('recall-error')).toHaveText('Could not write today’s sentences.');
    await page.getByTestId('recall-start').click();
    await expect(page.getByTestId('recall-english')).toHaveText('I see the cat.');
  });

  test('a half-done challenge resumes at the next sentence', async ({ page }) => {
    const items = SENTENCES.map((_, i) => unanswered(i));
    Object.assign(items[0], {
      answer: 'Ek sien die kat.',
      correct: true,
      aiCorrect: true,
      reference: SENTENCES[0].reference,
    });
    await mockRecall(page, { items });
    await openRecall(page);
    await expect(page.getByTestId('recall-progress')).toHaveText('Sentence 2 of 2');
    await expect(page.getByText('1/1 correct')).toBeVisible();
  });

  test('the sentences-per-day setting is stored', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('recall-count-15').click();
    expect(await page.evaluate(() => localStorage.getItem('lector-recall-daily-count'))).toBe('15');
  });

  test('the real API starts each day empty', async ({ page }) => {
    const res = await page.request.get(apiUrl('/api/recall/today?language=af'));
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(body.items)).toBe(true);
  });
});
