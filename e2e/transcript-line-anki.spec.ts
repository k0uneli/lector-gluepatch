import { test, expect, Page, Route } from '@playwright/test';
import { apiUrl } from './api';

/**
 * E2E for adding a transcript line to Anki (AnkiConnect transport).
 *
 * Covers:
 *   - The button beside a line stays hidden until the line is hovered
 *   - Listen-along line → the chosen sentence note type, with the AI
 *     translation and a clip that the server cuts from the uploaded audio
 *   - With no sentence format, a Basic card with the clip on the front
 *   - A YouTube line (no media file) falls back to server TTS
 *   - The add-on transport shows no button
 *   - A failed translation marks the button and adds no card
 *
 * AnkiConnect, /api/translate and /api/tts are mocked. The clip is real: the
 * lesson holds an uploaded WAV and the API cuts it with ffmpeg.
 */

interface AnkiCall {
  action: string;
  params?: {
    filename?: string;
    data?: string;
    note?: { modelName?: string; fields?: Record<string, string>; tags?: string[] };
  };
}

const SEGMENTS = [
  { idx: 0, startMs: 0, endMs: 2000, text: 'Goeie môre almal.' },
  { idx: 1, startMs: 2000, endMs: 4000, text: 'Welkom by die potgooi.' },
  { idx: 2, startMs: 4000, endMs: 6000, text: 'Tot volgende keer.' },
];

const SENTENCE_FORMAT = {
  af: {
    sentence: {
      modelName: 'vocabsieve-notes-with-url',
      fields: {
        Word: 'sentence',
        Definition: 'definition',
        'Definition#2': 'definition2',
        Image: 'image',
        Pronunciation: 'audio',
      },
    },
  },
};

/** 16-bit mono PCM WAV of silence. */
function silentWav(seconds: number): Buffer {
  const sampleRate = 8000;
  const dataSize = Math.round(sampleRate * seconds) * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

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

async function mockPhraseTranslation(
  page: Page,
  ok = true,
): Promise<Array<Record<string, string>>> {
  const requests: Array<Record<string, string>> = [];
  await page.route('**/api/translate', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    requests.push(body);
    await route.fulfill(
      ok
        ? {
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              translation: `[en: ${body.word}]`,
              idiomaticMeaning: 'a greeting on a podcast',
              usageNotes: 'informal',
            }),
          }
        : {
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'LLM unavailable' }),
          },
    );
  });
  return requests;
}

async function saveFormats(page: Page, formats: unknown) {
  const res = await page.request.put(apiUrl('/api/settings/ankiNoteFormats'), {
    data: { value: formats },
  });
  expect(res.ok()).toBeTruthy();
}

/** Upload a real WAV, then stub the lesson as transcribed into SEGMENTS. */
async function openListenAlong(page: Page): Promise<string> {
  const res = await page.request.post(apiUrl('/api/import/audio'), {
    multipart: {
      file: { name: 'episode.wav', mimeType: 'audio/wav', buffer: silentWav(6.5) },
      language: 'af',
      title: 'E2E Reël Anki',
    },
  });
  expect(res.ok()).toBeTruthy();
  const { lessonId } = await res.json();

  await page.route(`**/api/lessons/${lessonId}`, async (route) => {
    const response = await route.fetch();
    const lesson = await response.json();
    await route.fulfill({
      response,
      json: {
        ...lesson,
        textContent: SEGMENTS.map((s) => s.text).join(' '),
        transcriptionStatus: 'done',
        transcriptionError: null,
        audioDurationMs: 6000,
      },
    });
  });
  await page.route(`**/api/lessons/${lessonId}/segments`, (route) =>
    route.fulfill({ json: SEGMENTS }),
  );

  await page.goto(`/read/${lessonId}`);
  await expect(page.getByText('Goeie môre almal.')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('listen-along-toggle').click();
  await expect(page.getByTestId('listen-segment')).toHaveCount(3);
  return lessonId;
}

async function cleanup(page: Page) {
  const res = await page.request.get(apiUrl('/api/collections'));
  for (const c of await res.json()) {
    if (c.title?.startsWith('E2E Reël') || c.title === 'Klein Rooikappie') {
      await page.request.delete(apiUrl(`/api/collections/${c.id}`));
    }
  }
}

test.describe('Add a transcript line to Anki', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.request.delete(apiUrl('/api/settings/ankiConnectUrl')).catch(() => {});
    await page.request.delete(apiUrl('/api/settings/ankiTransport')).catch(() => {});
    await page.request.delete(apiUrl('/api/settings/ankiNoteFormats')).catch(() => {});
    await cleanup(page);
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(apiUrl('/api/settings/ankiNoteFormats')).catch(() => {});
    await page.request.delete(apiUrl('/api/settings/ankiTransport')).catch(() => {});
    await cleanup(page);
  });

  test('listen-along: hover a line and add it with its audio clip', async ({ page }) => {
    const calls = await mockAnkiConnect(page);
    const translations = await mockPhraseTranslation(page);
    await saveFormats(page, SENTENCE_FORMAT);
    const lessonId = await openListenAlong(page);

    const button = page.getByTestId('add-line-to-anki').nth(1);
    await expect(button).toHaveCSS('opacity', '0');
    await page.getByTestId('listen-segment').nth(1).hover();
    await expect(button).toHaveCSS('opacity', '1');

    await button.click();
    await expect(button).toHaveAttribute('data-status', 'done', { timeout: 15000 });

    expect(translations[0].word).toBe('Welkom by die potgooi.');
    expect(translations[0].sentence).toBe(SEGMENTS.map((s) => s.text).join(' '));

    const media = calls.find((c) => c.action === 'storeMediaFile')!.params!;
    expect(media.filename).toBe(`lector-clip-${lessonId}-2000-4000.mp3`);
    // An MP3 from ffmpeg opens with an ID3 tag ("ID3" → "SUQz").
    expect(media.data!.startsWith('SUQz')).toBe(true);
    expect(Buffer.from(media.data!, 'base64').length).toBeGreaterThan(1000);

    const note = calls.find((c) => c.action === 'addNote')!.params!.note!;
    expect(note.modelName).toBe('vocabsieve-notes-with-url');
    expect(note.tags).toEqual(['lector-sentence']);
    expect(note.fields).toEqual({
      Word: 'Welkom by die potgooi.',
      Definition: '[en: Welkom by die potgooi.]',
      'Definition#2': '<b>Meaning:</b> a greeting on a podcast<br><b>Usage:</b> informal',
      Image: '',
      Pronunciation: `[sound:${media.filename}]`,
    });

    // The row click seeks; the button click must not.
    await expect(page.getByTestId('listen-segment').nth(1)).not.toHaveAttribute(
      'data-active-segment',
      'true',
    );
  });

  test('without a sentence format, the line becomes a Basic card', async ({ page }) => {
    const calls = await mockAnkiConnect(page);
    await mockPhraseTranslation(page);
    const lessonId = await openListenAlong(page);

    await page.getByTestId('listen-segment').first().hover();
    const button = page.getByTestId('add-line-to-anki').first();
    await button.click();
    await expect(button).toHaveAttribute('data-status', 'done', { timeout: 15000 });

    const note = calls.find((c) => c.action === 'addNote')!.params!.note!;
    expect(note.modelName).toBe('Basic');
    expect(note.tags).toEqual(['lector-sentence']);
    expect(note.fields!.Front).toBe(
      `<bdi>Goeie môre almal.</bdi><br>[sound:lector-clip-${lessonId}-0-2000.mp3]`,
    );
    expect(note.fields!.Back).toContain('[en: Goeie môre almal.]');
    expect(note.fields!.Back).toContain('<b>Meaning:</b> a greeting on a podcast');
  });

  test('a YouTube line has no media file, so it uses server TTS', async ({ page }) => {
    test.skip(
      !!process.env.E2E_EXTERNAL_SERVER,
      'YouTube fixtures are not in the production image',
    );
    const calls = await mockAnkiConnect(page);
    await mockPhraseTranslation(page);
    await page.route('**/api/tts', (route) =>
      route.fulfill({ json: { audioContent: 'SUQzBAAAAAAA', contentType: 'audio/mp3' } }),
    );
    await saveFormats(page, SENTENCE_FORMAT);

    const res = await page.request.post(apiUrl('/api/import/youtube'), {
      data: {
        url: 'https://www.youtube.com/watch?v=vid00000010',
        languageCode: 'af',
        kind: 'standard',
        language: 'af',
      },
    });
    expect(res.ok()).toBeTruthy();
    const { lessonId } = await res.json();
    await page.goto(`/read/${lessonId}`);
    await expect(page.getByTestId('transcript-reader')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('transcript-segment').first().hover();
    const button = page.getByTestId('add-line-to-anki').first();
    await button.click();
    await expect(button).toHaveAttribute('data-status', 'done', { timeout: 15000 });

    const media = calls.find((c) => c.action === 'storeMediaFile')!.params!;
    expect(media.filename).toMatch(/^lector-af-[0-9a-f]{8}\.mp3$/);
    const note = calls.find((c) => c.action === 'addNote')!.params!.note!;
    expect(note.fields!.Pronunciation).toBe(`[sound:${media.filename}]`);
  });

  test('the add-on transport shows no button', async ({ page }) => {
    await page.request.put(apiUrl('/api/settings/ankiTransport'), { data: { value: 'addon' } });
    await openListenAlong(page);
    await expect(page.getByTestId('add-line-to-anki')).toHaveCount(0);
  });

  test('a failed translation marks the button and adds no card', async ({ page }) => {
    const calls = await mockAnkiConnect(page);
    await mockPhraseTranslation(page, false);
    await openListenAlong(page);

    await page.getByTestId('listen-segment').first().hover();
    const button = page.getByTestId('add-line-to-anki').first();
    await button.click();
    await expect(button).toHaveAttribute('data-status', 'error', { timeout: 15000 });
    await expect(page.getByText('LLM unavailable')).toBeVisible();
    expect(calls.some((c) => c.action === 'addNote')).toBe(false);
  });

  test('a word card gets the word TTS and the line clip as sentence audio', async ({ page }) => {
    const calls = await mockAnkiConnect(page);
    const ttsTexts: string[] = [];
    await page.route('**/api/tts', async (route) => {
      ttsTexts.push(JSON.parse(route.request().postData() || '{}').text);
      await route.fulfill({ json: { audioContent: 'SUQzBAAAAAAA', contentType: 'audio/mp3' } });
    });
    await page.route('**/api/translate/gloss', (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: 'welcome' }),
    );
    await saveFormats(page, {
      af: {
        word: {
          modelName: 'vocabsieve-notes-with-url',
          fields: {
            Word: 'word',
            Sentence: 'sentence',
            Pronunciation: 'audio',
            SentenceAudio: 'sentenceAudio',
          },
        },
      },
    });
    const lessonId = await openListenAlong(page);

    await page.getByTestId('listen-segment').nth(1).getByTestId('reader-word').first().click();
    const addBtn = page.getByTestId('translation-drawer').getByTestId('add-to-anki-btn');
    await expect(addBtn).toBeVisible({ timeout: 8000 });
    await addBtn.click();
    await expect(addBtn).toHaveText('✓ Added to Anki', { timeout: 15000 });

    const files = calls
      .filter((c) => c.action === 'storeMediaFile')
      .map((c) => c.params!.filename!);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^lector-af-[0-9a-f]{8}\.mp3$/);
    expect(files[1]).toBe(`lector-clip-${lessonId}-2000-4000.mp3`);
    expect(ttsTexts).toContain('Welkom');

    const note = calls.find((c) => c.action === 'addNote')!.params!.note!;
    expect(note.modelName).toBe('vocabsieve-notes-with-url');
    expect(note.fields!.Word).toBe('Welkom');
    expect(note.fields!.Sentence).toBe('<b>Welkom</b> by die potgooi.');
    expect(note.fields!.Pronunciation).toBe(`[sound:${files[0]}]`);
    expect(note.fields!.SentenceAudio).toBe(`[sound:${files[1]}]`);
  });
});
