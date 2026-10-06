import { test, expect, Page, Route } from '@playwright/test';
import { apiUrl } from './api';

/**
 * Adding to Anki from cloze practice (AnkiConnect transport).
 *
 * Covers:
 *   - A word looked up in the drawer becomes a word card, built from the full
 *     sentence rather than the blanked one, and gets a vocab entry
 *   - The sentence button appears after an incorrect answer too
 *   - An AnkiConnect error marks the word button and adds no note
 *
 * AnkiConnect and the gloss endpoint are mocked.
 */

const SENTENCE_ID = 'e2e-practice-anki-1';
const SENTENCE = {
  id: SENTENCE_ID,
  sentence: 'Ek staan voor die deur.',
  clozeWord: 'voor',
  clozeIndex: 2,
  translation: 'I stand in front of the door.',
  source: 'tatoeba',
  collection: 'top500',
  masteryLevel: 0,
  nextReview: new Date().toISOString(),
  reviewCount: 0,
  timesCorrect: 0,
  timesIncorrect: 0,
};

interface AnkiCall {
  action: string;
  params?: { note?: { modelName?: string; fields?: Record<string, string>; tags?: string[] } };
}

async function mockAnkiConnect(
  page: Page,
  addNoteError: string | null = null,
): Promise<AnkiCall[]> {
  const calls: AnkiCall[] = [];
  const handle = async (route: Route) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': 'application/json',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 200, headers });
      return;
    }
    const body = JSON.parse(route.request().postData() || '{}') as AnkiCall;
    calls.push(body);
    const results: Record<string, unknown> = { version: 6, createDeck: 1, addNote: 1234567890 };
    const error = body.action === 'addNote' ? addNoteError : null;
    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify({ result: error ? null : (results[body.action] ?? null), error }),
    });
  };
  await page.route('**://localhost:8765/**', handle);
  await page.route('http://localhost:8765/', handle);
  return calls;
}

/** Start a Type round and return the sentence the round opened on. */
async function startTypeRound(page: Page): Promise<string> {
  await page.goto('/practice');
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30000 });
  await page
    .getByText('Learn New')
    .locator('..')
    .getByRole('button', { name: /Top 500/ })
    .first()
    .click();
  await page.getByRole('button', { name: '10', exact: true }).click();
  await page.getByRole('button', { name: 'Type' }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Fill in the blank')).toBeVisible({ timeout: 10000 });
  return (await page.getByTestId('cloze-word').allTextContents()).join(' ');
}

async function vocabTexts(
  page: Page,
): Promise<Array<{ id: string; text: string; pushedToAnki: boolean }>> {
  return (await page.request.get(apiUrl('/api/vocab'))).json();
}

test.describe('Cloze practice → Anki', () => {
  let createdWord: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.delete(apiUrl('/api/settings/ankiConnectUrl')).catch(() => {});
    await page.request.delete(apiUrl('/api/settings/ankiTransport')).catch(() => {});
    await page.request.delete(apiUrl('/api/settings/ankiNoteFormats')).catch(() => {});
    expect((await page.request.post(apiUrl('/api/cloze'), { data: [SENTENCE] })).ok()).toBeTruthy();
    await page.route('**/api/dictionary/lookup?*', (route) =>
      route.fulfill({ json: { entry: null } }),
    );
    await page.route('**/api/translate/gloss', (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: 'test gloss' }),
    );
    await page.route('**/api/tts', (route) =>
      route.fulfill({ json: { error: 'no voice', fallback: true } }),
    );
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(apiUrl(`/api/cloze/${SENTENCE_ID}`));
    if (createdWord) {
      for (const v of await vocabTexts(page)) {
        if (v.text === createdWord) await page.request.delete(apiUrl(`/api/vocab/${v.id}`));
      }
      createdWord = null;
    }
  });

  test('a word from the drawer becomes a word card with the full sentence', async ({ page }) => {
    const calls = await mockAnkiConnect(page);
    await page.request.put(apiUrl('/api/settings/ankiNoteFormats'), {
      data: {
        value: {
          af: { word: { modelName: 'Mining', fields: { Word: 'word', Sentence: 'sentence' } } },
        },
      },
    });
    await startTypeRound(page);

    const word = page.getByTestId('cloze-word').first();
    const text = (await word.textContent())!.trim().replace(/[.,!?]+$/, '');
    createdWord = text.toLowerCase();
    await word.click();

    const addBtn = page.getByTestId('translation-drawer').getByTestId('add-to-anki-btn');
    await expect(addBtn).toBeVisible({ timeout: 8000 });
    await addBtn.click();
    await expect(addBtn).toHaveText('✓ Added to Anki', { timeout: 5000 });

    const note = calls.find((c) => c.action === 'addNote')!.params!.note!;
    expect(note.modelName).toBe('Mining');
    expect(note.tags).toContain('lector');
    expect(note.fields!.Word.toLowerCase()).toBe(createdWord);
    expect(note.fields!.Sentence).toContain(`<b>${text}</b>`);
    expect(note.fields!.Sentence).not.toContain('___');
    expect(note.fields!.Sentence).not.toContain('…');

    await expect
      .poll(async () => (await vocabTexts(page)).find((v) => v.text === createdWord)?.pushedToAnki)
      .toBe(true);
  });

  test('the sentence button appears after an incorrect answer', async ({ page }) => {
    const calls = await mockAnkiConnect(page);
    await startTypeRound(page);

    const input = page.locator('input[placeholder="..."]');
    await input.fill('zzzzz');
    await input.press('Enter');
    await expect(page.getByRole('heading', { name: 'Incorrect' })).toBeVisible({ timeout: 5000 });

    const addSentence = page.getByTestId('add-sentence-to-anki');
    await expect(addSentence).toBeVisible();
    await addSentence.click();
    await expect(addSentence).toHaveAttribute('title', 'Already added to Anki', { timeout: 5000 });

    const note = calls.find((c) => c.action === 'addNote')!.params!.note!;
    expect(note.modelName).toBe('Cloze');
    expect(note.fields!.Text).toContain('{{c1::');
  });

  test('an AnkiConnect error marks the word button and adds no note', async ({ page }) => {
    const calls = await mockAnkiConnect(page, 'collection is not available');
    await startTypeRound(page);

    const word = page.getByTestId('cloze-word').first();
    createdWord = (await word.textContent())!
      .trim()
      .replace(/[.,!?]+$/, '')
      .toLowerCase();
    await word.click();
    const addBtn = page.getByTestId('translation-drawer').getByTestId('add-to-anki-btn');
    await expect(addBtn).toBeVisible({ timeout: 8000 });
    await addBtn.click();

    await expect(addBtn).toHaveText('Anki error — retry', { timeout: 5000 });
    await expect(addBtn).not.toBeDisabled();
    expect(calls.filter((c) => c.action === 'addNote')).toHaveLength(1);
  });
});
