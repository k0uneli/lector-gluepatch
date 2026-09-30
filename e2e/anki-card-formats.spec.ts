import { test, expect, Page, Route } from '@playwright/test';
import { apiUrl } from './api';
import path from 'path';

/**
 * E2E for user-defined Anki card formats (AnkiConnect transport).
 *
 * Covers:
 *   - Settings: picking any note type AnkiConnect reports, guessed field
 *     mapping, editing a field, and resetting to Lector's default card
 *   - Settings with Anki unreachable: the note type picker is disabled
 *   - Reader word card: addNote uses the chosen note type, and the audio field
 *     carries the stored TTS file
 *   - Reader sentence card that is not a cloze: no word pick needed, and the
 *     sentence field holds the selection
 *   - No server voice: the note is still added, with the audio field empty
 *
 * AnkiConnect and /api/tts are mocked.
 */

interface AnkiCall {
  action: string;
  params?: {
    modelName?: string;
    filename?: string;
    data?: string;
    note?: { modelName?: string; fields?: Record<string, string>; tags?: string[] };
  };
}

const MODEL_FIELDS: Record<string, string[]> = {
  Basic: ['Front', 'Back'],
  Mining: [
    'Expression',
    'Sentence',
    'MainDefinition',
    'Glossary',
    'Picture',
    'ExpressionAudio',
    'Notes',
  ],
};

async function mockAnkiConnect(page: Page): Promise<AnkiCall[]> {
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
    const results: Record<string, unknown> = {
      version: 6,
      deckNames: ['Afrikaans', 'Afrikaans::Cloze'],
      modelNames: Object.keys(MODEL_FIELDS),
      modelFieldNames: MODEL_FIELDS[body.params?.modelName ?? ''] ?? [],
      createDeck: 1,
      storeMediaFile: body.params?.filename ?? null,
      addNote: 1234567890,
    };
    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify({ result: results[body.action] ?? null, error: null }),
    });
  };
  await page.route('**://localhost:8765/**', handle);
  await page.route('http://localhost:8765/', handle);
  return calls;
}

async function mockTts(page: Page, available: boolean) {
  await page.route('**/api/tts', async (route) => {
    await route.fulfill({
      status: available ? 200 : 503,
      contentType: 'application/json',
      body: JSON.stringify(
        available
          ? { audioContent: 'SUQzBAAAAAAA', contentType: 'audio/mp3' }
          : { error: 'Google Cloud API key not configured', fallback: true },
      ),
    });
  });
}

async function saveFormats(page: Page, formats: unknown) {
  const res = await page.request.put(apiUrl('/api/settings/ankiNoteFormats'), {
    data: { value: formats },
  });
  expect(res.ok()).toBeTruthy();
}

async function storedFormats(page: Page) {
  const res = await page.request.get(apiUrl('/api/settings/ankiNoteFormats'));
  return res.json();
}

async function importAndOpenReader(page: Page) {
  const fs = await import('fs');
  const buffer = fs.readFileSync(path.join(__dirname, 'fixtures/test-book.epub'));
  const importRes = await page.request.post(apiUrl('/api/import/epub'), {
    multipart: { file: { name: 'test-book.epub', mimeType: 'application/epub+zip', buffer } },
  });
  const { collectionId } = await importRes.json();
  const lessons = await (
    await page.request.get(apiUrl(`/api/collections/${collectionId}/lessons`))
  ).json();
  await page.goto(`/read/${lessons[0].id}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Dit is die eerste hoofstuk')).toBeVisible({ timeout: 10000 });
}

async function cleanupCollections(page: Page) {
  const collections = await (await page.request.get(apiUrl('/api/collections'))).json();
  for (const c of collections) {
    if (c.title.startsWith('Toets') || c.title.startsWith('Test')) {
      await page.request.delete(apiUrl(`/api/collections/${c.id}`));
    }
  }
}

async function selectPhrase(page: Page) {
  const words = page.locator('article span.cursor-pointer');
  const box1 = await words.first().boundingBox();
  const box2 = await words.nth(2).boundingBox();
  if (!box1 || !box2) throw new Error('No bounding boxes');
  await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.up();
}

test.describe('Anki card formats', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.delete(apiUrl('/api/settings/ankiConnectUrl')).catch(() => {});
    await page.request.delete(apiUrl('/api/settings/ankiTransport')).catch(() => {});
    await page.request.delete(apiUrl('/api/settings/ankiNoteFormats')).catch(() => {});
    await page.route('**/api/translate', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ translation: `[test: ${body.word}]`, partOfSpeech: 'noun' }),
      });
    });
    await page.route('**/api/translate/gloss', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'test gloss' });
    });
    await cleanupCollections(page);
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(apiUrl('/api/settings/ankiNoteFormats')).catch(() => {});
    await cleanupCollections(page);
  });

  test('settings: pick a note type, edit a field, then reset to default', async ({ page }) => {
    await mockAnkiConnect(page);
    await page.goto('/settings');
    const formats = page.getByTestId('anki-card-formats');
    await expect(formats).toBeVisible({ timeout: 10000 });

    const language = await formats.getByTestId('anki-format-language').inputValue();
    const model = formats.getByTestId('anki-format-model');
    await expect(model.locator('option', { hasText: 'Mining' })).toBeAttached({ timeout: 5000 });
    await model.selectOption('Mining');

    await expect(formats.getByTestId('anki-format-field-Expression')).toHaveValue('word');
    await expect(formats.getByTestId('anki-format-field-ExpressionAudio')).toHaveValue('audio');
    await expect(formats.getByTestId('anki-format-field-Notes')).toHaveValue('');
    await formats.getByTestId('anki-format-field-Notes').selectOption('definition2');

    await expect
      .poll(async () => (await storedFormats(page))?.[language]?.word?.fields)
      .toEqual({
        Expression: 'word',
        Sentence: 'sentence',
        MainDefinition: 'definition',
        Glossary: 'definition2',
        Picture: 'image',
        ExpressionAudio: 'audio',
        Notes: 'definition2',
      });

    // The sentence card has its own, still unset, format.
    await formats.getByTestId('anki-format-kind').selectOption('sentence');
    await expect(model).toHaveValue('');
    await formats.getByTestId('anki-format-kind').selectOption('word');
    await expect(model).toHaveValue('Mining');

    await model.selectOption('');
    await expect(formats.getByTestId('anki-format-fields')).toHaveCount(0);
    await expect.poll(async () => (await storedFormats(page))?.[language]).toBeUndefined();
  });

  test('settings: the note type picker is disabled while Anki is unreachable', async ({ page }) => {
    await page.route('**://localhost:8765/**', (route) => route.abort());
    await page.route('http://localhost:8765/', (route) => route.abort());
    await page.goto('/settings');
    const formats = page.getByTestId('anki-card-formats');
    await expect(formats).toBeVisible({ timeout: 10000 });
    await expect(formats.getByText('Connect to Anki to list your note types.')).toBeVisible();
    await expect(formats.getByTestId('anki-format-model')).toBeDisabled();
  });

  test('reader: a word card uses the chosen note type and stores TTS audio', async ({ page }) => {
    const calls = await mockAnkiConnect(page);
    await mockTts(page, true);
    await saveFormats(page, {
      af: {
        word: {
          modelName: 'Mining',
          fields: {
            Expression: 'word',
            Sentence: 'sentence',
            MainDefinition: 'definition',
            Picture: 'image',
            ExpressionAudio: 'audio',
          },
        },
      },
    });
    await importAndOpenReader(page);

    const wordSpan = page.locator('article span.cursor-pointer').first();
    const word = (await wordSpan.textContent())!.trim();
    await wordSpan.click();

    const drawer = page.getByTestId('translation-drawer');
    const addBtn = drawer.getByTestId('add-to-anki-btn');
    await expect(addBtn).toBeVisible({ timeout: 8000 });
    await addBtn.click();
    await expect(addBtn).toHaveText('✓ Added to Anki', { timeout: 5000 });

    const media = calls.find((c) => c.action === 'storeMediaFile');
    expect(media!.params!.filename).toMatch(/^lector-af-[0-9a-f]{8}\.mp3$/);
    expect(media!.params!.data).toBe('SUQzBAAAAAAA');

    const note = calls.find((c) => c.action === 'addNote')!.params!.note!;
    expect(note.modelName).toBe('Mining');
    expect(note.tags).toContain('lector');
    expect(note.fields!.Expression.toLowerCase()).toBe(word.toLowerCase());
    expect(note.fields!.Sentence).toMatch(/<b>[^<]+<\/b>/);
    expect(note.fields!.MainDefinition).not.toBe('');
    expect(note.fields!.Picture).toBe('');
    expect(note.fields!.ExpressionAudio).toBe(`[sound:${media!.params!.filename}]`);
  });

  test('reader: a sentence card that is not a cloze needs no word pick', async ({ page }) => {
    const calls = await mockAnkiConnect(page);
    await mockTts(page, true);
    await saveFormats(page, {
      af: {
        sentence: {
          modelName: 'Mining',
          fields: { Sentence: 'sentence', MainDefinition: 'definition', ExpressionAudio: 'audio' },
        },
      },
    });
    await importAndOpenReader(page);
    await selectPhrase(page);

    const drawer = page.getByTestId('translation-drawer');
    const addBtn = drawer.getByTestId('add-cloze-btn');
    await expect(addBtn).toHaveText('Add to Anki as sentence card', { timeout: 8000 });
    await addBtn.click();
    await expect(drawer.getByText('Pick the target word (optional):')).toBeVisible();

    const sendBtn = drawer.getByTestId('cloze-send-btn');
    await expect(sendBtn).not.toBeDisabled();
    await sendBtn.click();
    await expect(sendBtn).toHaveText('✓ Sent to Anki', { timeout: 5000 });

    const note = calls.find((c) => c.action === 'addNote')!.params!.note!;
    expect(note.modelName).toBe('Mining');
    expect(note.tags).not.toContain('cloze');
    expect(note.fields!.Sentence.split(/\s+/).length).toBeGreaterThanOrEqual(2);
    expect(note.fields!.Sentence).not.toContain('<b>');
    expect(note.fields!.Sentence).not.toContain('{{c1::');
    expect(note.fields!.ExpressionAudio).toMatch(/^\[sound:lector-af-[0-9a-f]{8}\.mp3\]$/);
  });

  test('reader: with no server voice the card is added without audio', async ({ page }) => {
    const calls = await mockAnkiConnect(page);
    await mockTts(page, false);
    await saveFormats(page, {
      af: {
        word: { modelName: 'Mining', fields: { Expression: 'word', ExpressionAudio: 'audio' } },
      },
    });
    await importAndOpenReader(page);

    await page.locator('article span.cursor-pointer').first().click();
    const addBtn = page.getByTestId('translation-drawer').getByTestId('add-to-anki-btn');
    await expect(addBtn).toBeVisible({ timeout: 8000 });
    await addBtn.click();
    await expect(addBtn).toHaveText('✓ Added to Anki', { timeout: 5000 });
    await expect(page.getByText('Added to Anki without audio')).toBeVisible();

    expect(calls.some((c) => c.action === 'storeMediaFile')).toBe(false);
    const note = calls.find((c) => c.action === 'addNote')!.params!.note!;
    expect(note.fields!.ExpressionAudio).toBe('');
  });
});
