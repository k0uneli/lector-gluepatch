import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addPracticeWordToAnki, type PracticeWordLookup } from '../add-word-to-anki';
import { getLanguageConfig } from '@/lib/languages';
import { clearQueryCache } from '@/lib/query-cache';
import type { AnkiNoteFormats } from '@/lib/anki-formats';

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

const lookup = (overrides: Partial<PracticeWordLookup> = {}): PracticeWordLookup => ({
  word: 'слышу',
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

describe('addPracticeWordToAnki', () => {
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

    await addPracticeWordToAnki(lookup(), SENTENCE, 'ankiconnect', ru);

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

    await addPracticeWordToAnki(lookup(), SENTENCE, 'ankiconnect', ru);

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

    await addPracticeWordToAnki(lookup(), SENTENCE, 'ankiconnect', ru);

    expect(calls.some((c) => c.url.includes('/api/vocab') && c.method === 'POST')).toBe(false);
    expect(calls.find((c) => c.method === 'PUT')!.url).toContain('/api/vocab/v1');
  });

  it('prefers the in-context AI translation', async () => {
    const calls = stubServers({
      formats: {
        ru: { word: { modelName: 'M', fields: { Word: 'word', Definition: 'definition' } } },
      },
    });

    await addPracticeWordToAnki(
      lookup({ dictEntry: null, aiContextTranslation: 'I hear', translation: 'I hear' }),
      SENTENCE,
      'ankiconnect',
      ru,
    );

    expect(ankiNote(calls).note.fields.Definition).toBe('I hear');
  });

  it('queues the word for the add-on and never calls AnkiConnect', async () => {
    const calls = stubServers();

    await addPracticeWordToAnki(lookup(), SENTENCE, 'addon', ru);

    const queued = calls.find((c) => c.url.includes('/api/anki/queue'))!.body!;
    expect(queued.items).toEqual([
      expect.objectContaining({
        cardType: 'word',
        word: 'слышу',
        meaning: 'to hear — first-person singular … of слы́шать',
      }),
    ]);
    expect(calls.some((c) => c.body?.action)).toBe(false);
  });
});
