import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addWordCardToAnki,
  ankiDeckNames,
  ensureVocabEntry,
  newVocabEntry,
  wordCardTexts,
  type WordLookup,
} from '../anki-word-card';
import type { AnkiTransport } from '../anki-transport';
import { getLanguageConfig } from '../languages';
import { clearQueryCache } from '../query-cache';
import type { AnkiNoteFormat, AnkiNoteFormats } from '../anki-formats';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

const ru = getLanguageConfig('ru');
const SENTENCE = 'Я слышу музыку.';

function stubServers(opts: { formats?: AnkiNoteFormats; existingVocab?: unknown[] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.includes('/api/settings/ankiConnectUrl')) return Response.json(null);
      if (url.includes('/api/settings/ankiNoteFormats')) return Response.json(opts.formats ?? {});
      if (url.includes('/api/tts')) return Response.json({ error: 'no voice', fallback: true });
      if (url.includes('/api/anki/queue')) return Response.json({ queued: 1, failed: [] });
      if (url.includes('/api/vocab') && method === 'GET') {
        return Response.json(opts.existingVocab ?? []);
      }
      if (url.includes('/api/vocab') && method === 'POST') return Response.json({ id: body?.id });
      if (url.includes('/api/vocab/')) return Response.json({ ok: true });
      const results: Record<string, unknown> = { createDeck: 1, addNote: 77 };
      return Response.json({ result: results[String(body?.action)] ?? null, error: null });
    }),
  );
  return calls;
}

const lookup = (overrides: Partial<WordLookup> = {}): WordLookup => ({
  word: 'слышу',
  sentence: SENTENCE,
  translation: 'to hear — first-person singular … of слы́шать',
  aiContextTranslation: null,
  aiStructured: null,
  dictEntry: {
    word: 'слышу',
    source: 'dict',
    senses: [{ partOfSpeech: 'verb', gloss: 'first-person singular … of слы́шать' }],
    lemmaEntries: [{ word: 'слышать', senses: [{ partOfSpeech: 'verb', gloss: 'to hear' }] }],
  },
  ...overrides,
});

const ankiNote = (calls: Call[]) =>
  calls.find((c) => c.body?.action === 'addNote')?.body?.params as {
    note: { modelName: string; deckName: string; fields: Record<string, string> };
  };

beforeEach(() => {
  clearQueryCache();
  const store = new Map<string, string>([['lector-anki-deck', 'Russian']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What cloze practice does: ensure the entry, then send the card. */
async function addPracticeWord(word: WordLookup, transport: AnkiTransport) {
  const entry = await ensureVocabEntry({
    word: word.word,
    sentence: word.sentence,
    translation: word.translation ?? '',
    pack: ru,
  });
  return addWordCardToAnki({ lookup: word, vocabEntryId: entry.id, transport, pack: ru });
}

describe('addWordCardToAnki', () => {
  it('fills the word format with the full sentence and the lemma meaning', async () => {
    const calls = stubServers({
      formats: {
        ru: {
          word: {
            modelName: 'vocabsieve-notes-with-url',
            fields: { Word: 'word', Sentence: 'sentence', Definition: 'definition' },
          },
        },
      },
    });

    await addPracticeWord(lookup(), 'ankiconnect');

    const { note } = ankiNote(calls);
    expect(note.modelName).toBe('vocabsieve-notes-with-url');
    expect(note.deckName).toBe('Russian');
    expect(note.fields).toEqual({
      Word: 'слышу',
      Sentence: 'Я <b>слышу</b> музыку.',
      Definition: 'to hear — first-person singular … of слы́шать',
    });
  });

  it('creates a level1 vocab entry and marks it pushed', async () => {
    const calls = stubServers();

    await addPracticeWord(lookup(), 'ankiconnect');

    const created = calls.find((c) => c.url.includes('/api/vocab') && c.method === 'POST')!.body!;
    expect(created).toMatchObject({ text: 'слышу', state: 'level1', sentence: SENTENCE });
    const pushed = calls.find((c) => c.method === 'PUT')!;
    expect(pushed.url).toContain(`/api/vocab/${created.id}`);
    expect(pushed.body).toEqual({ pushedToAnki: true, ankiNoteId: 77 });
    expect(ankiNote(calls).note.modelName).toBe('Basic');
  });

  it('reuses an existing vocab entry', async () => {
    const calls = stubServers({
      existingVocab: [
        { id: 'v1', text: 'слышу', stateUpdatedAt: '2026-10-01', createdAt: '2026-10-01' },
      ],
    });

    await addPracticeWord(lookup(), 'ankiconnect');

    expect(calls.some((c) => c.url.includes('/api/vocab') && c.method === 'POST')).toBe(false);
    expect(calls.find((c) => c.method === 'PUT')!.url).toContain('/api/vocab/v1');
  });

  it('prefers the in-context AI translation', async () => {
    const calls = stubServers({
      formats: {
        ru: { word: { modelName: 'M', fields: { Word: 'word', Definition: 'definition' } } },
      },
    });

    await addPracticeWord(
      lookup({ dictEntry: null, aiContextTranslation: 'I hear', translation: 'I hear' }),
      'ankiconnect',
    );

    expect(ankiNote(calls).note.fields.Definition).toBe('I hear');
  });

  it('queues the word for the add-on and never calls AnkiConnect', async () => {
    const calls = stubServers();

    const result = await addPracticeWord(lookup(), 'addon');
    expect(result).toEqual({ noteId: null, audioFailed: false });

    const queued = calls.find((c) => c.url.includes('/api/anki/queue'))!.body!;
    expect(queued.items).toEqual([
      expect.objectContaining({
        cardType: 'word',
        word: 'слышу',
        translation: 'to hear — first-person singular … of слы́шать',
        meaning: 'to hear — first-person singular … of слы́шать',
      }),
    ]);
    expect(calls.some((c) => c.body?.action)).toBe(false);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('puts the transcript link on the built-in card', async () => {
    const calls = stubServers();

    await addWordCardToAnki({
      lookup: lookup(),
      vocabEntryId: 'v1',
      transport: 'ankiconnect',
      pack: ru,
      format: null,
      source: { sourceUrl: 'https://www.youtube.com/watch?v=abc', startMs: 61000, endMs: 64000 },
    });

    expect(ankiNote(calls).note.fields.Back).toContain('watch?v=abc&amp;t=61s');
  });

  it('fetches the line clip only when the format has a Sentence audio field', async () => {
    stubServers();
    const getSentenceClip = vi.fn(async () => ({ data: 'SUQz', filename: 'clip.mp3' }));
    const source = { sourceUrl: '', startMs: 1000, endMs: 3000 };
    const withAudio: AnkiNoteFormat = {
      modelName: 'M',
      fields: { Word: 'word', SentenceAudio: 'sentenceAudio' },
    };
    const without: AnkiNoteFormat = { modelName: 'M', fields: { Word: 'word' } };

    const base = {
      lookup: lookup(),
      vocabEntryId: 'v1',
      transport: 'ankiconnect' as const,
      pack: ru,
    };
    await addWordCardToAnki({ ...base, format: without, source, getSentenceClip });
    expect(getSentenceClip).not.toHaveBeenCalled();
    await addWordCardToAnki({ ...base, format: withAudio, source, getSentenceClip });
    expect(getSentenceClip).toHaveBeenCalledWith(1000, 3000);
  });
});

describe('helpers', () => {
  it('wordCardTexts keeps the in-context translation apart from the first sense', () => {
    expect(
      wordCardTexts({
        translation: 'to hear; to listen',
        aiContextTranslation: 'I hear',
        aiStructured: null,
        dictEntry: { word: 'слышу', senses: [{ partOfSpeech: 'verb', gloss: 'to hear' }] },
      }),
    ).toEqual({ translation: 'I hear', meaning: 'to hear' });
  });

  it('newVocabEntry makes a multi-word selection a phrase and keeps the book', () => {
    const entry = newVocabEntry({
      word: 'Я слышу',
      sentence: SENTENCE,
      translation: 'I hear',
      pack: ru,
      bookId: 'lesson-1',
    });
    expect(entry).toMatchObject({
      text: 'я слышу',
      type: 'phrase',
      state: 'level1',
      bookId: 'lesson-1',
    });
    expect(newVocabEntry({ word: 'слышу', sentence: '', translation: '', pack: ru }).type).toBe(
      'word',
    );
  });

  it('ankiDeckNames reads the stored deck and falls back to the language name', () => {
    expect(ankiDeckNames(ru)).toEqual({ word: 'Russian', sentence: `${ru.native}::Cloze` });
  });
});
