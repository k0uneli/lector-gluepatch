import { afterEach, describe, expect, it, vi } from 'vitest';
import { addFormattedNote, addSentenceCard, syncWordStates, SENTENCE_CARD_TAG } from './anki';
import type { AnkiNoteFormats } from './anki-formats';

interface AnkiBody {
  action: string;
  params?: Record<string, unknown>;
}

const REVIEWED = { type: 2, interval: 30, deckName: 'Russian', note: 1 };

function stubServers(
  formats: AnkiNoteFormats,
  cards: unknown[],
  addNoteError: string | null = null,
) {
  const ankiCalls: AnkiBody[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/settings/ankiConnectUrl')) return Response.json(null);
    if (url.endsWith('/api/settings/ankiNoteFormats')) return Response.json(formats);
    if (url.endsWith('/api/tts')) return Response.json({ error: 'no voice', fallback: true });
    const body = JSON.parse(String(init?.body)) as AnkiBody;
    ankiCalls.push(body);
    const results: Record<string, unknown> = {
      findCards: cards.map((_, i) => i + 1),
      cardsInfo: cards,
      createDeck: 1,
      storeMediaFile: body.params?.filename,
      addNote: 42,
    };
    if (body.action === 'addNote' && addNoteError) {
      return Response.json({ result: null, error: addNoteError });
    }
    return Response.json({ result: results[body.action] ?? null, error: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  return ankiCalls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('syncWordStates with card formats', () => {
  it('reads the mapped word field, and skips a configured card with no word', async () => {
    stubServers(
      {
        ru: {
          word: { modelName: 'Mining', fields: { Word: 'word', Sentence: 'sentence' } },
          sentence: { modelName: 'Sentences', fields: { Front: 'sentence' } },
        },
      },
      [
        {
          ...REVIEWED,
          cardId: 1,
          modelName: 'Mining',
          fields: {
            Word: { value: 'кот', order: 0 },
            Sentence: { value: 'Мой <b>кот</b>', order: 1 },
          },
        },
        {
          ...REVIEWED,
          cardId: 2,
          modelName: 'Sentences',
          fields: { Front: { value: 'Кошка спит на диване', order: 0 } },
        },
        {
          ...REVIEWED,
          cardId: 3,
          modelName: 'Basic',
          fields: { Front: { value: '<b>дом</b>', order: 0 }, Back: { value: 'house', order: 1 } },
        },
      ],
    );

    const states = await syncWordStates();
    expect([...states.keys()].sort()).toEqual(['дом', 'кот']);
    expect(states.get('кот')?.sentence).toBe('Мой кот');
  });
});

describe('addSentenceCard', () => {
  it('puts the stored clip on the front and keeps the card out of the word sync', async () => {
    const calls = stubServers({}, []);

    const result = await addSentenceCard('Russian', 'Кошка спит.', 'The cat sleeps.', '', {
      language: 'ru',
      clip: { data: 'SUQz', filename: 'lector-clip-l1-1000-2000.mp3' },
    });

    expect(result).toEqual({ noteId: 42, audioFailed: false });
    expect(calls.find((c) => c.action === 'storeMediaFile')?.params).toEqual({
      data: 'SUQz',
      filename: 'lector-clip-l1-1000-2000.mp3',
    });
    const note = calls.find((c) => c.action === 'addNote')?.params?.note as {
      fields: Record<string, string>;
      tags: string[];
    };
    expect(note.fields.Front).toBe(
      '<bdi>Кошка спит.</bdi><br>[sound:lector-clip-l1-1000-2000.mp3]',
    );
    expect(note.fields.Back).toBe('The cat sleeps.');
    expect(note.tags).toEqual([SENTENCE_CARD_TAG]);
    expect(note.tags).not.toContain('lector');
  });

  it('adds the card without audio when there is no clip and no server voice', async () => {
    const calls = stubServers({}, []);

    const result = await addSentenceCard('Russian', 'Кошка спит.', 'The cat sleeps.', '', {
      language: 'ru',
    });

    expect(result.audioFailed).toBe(true);
    expect(calls.some((c) => c.action === 'storeMediaFile')).toBe(false);
    const note = calls.find((c) => c.action === 'addNote')?.params?.note as {
      fields: Record<string, string>;
    };
    expect(note.fields.Front).toBe('<bdi>Кошка спит.</bdi>');
  });
});

describe('addFormattedNote', () => {
  const format = {
    modelName: 'vocabsieve-notes-with-url',
    fields: { Word: 'word' as const, Sentence: 'sentence' as const },
  };
  const line = {
    word: '',
    sentence: 'Кошка спит.',
    definition: 'The cat sleeps.',
    definition2: '',
  };

  it('explains an empty first field instead of passing on Anki’s message', async () => {
    stubServers({}, [], 'cannot create note because it is empty');

    await expect(
      addFormattedNote(
        'Russian',
        { ...format, fields: { Definition2: 'definition2' as const } },
        line,
        {
          audioText: '',
          language: 'ru',
        },
      ),
    ).rejects.toThrow(
      "Anki rejected the note: the first field of 'vocabsieve-notes-with-url' is empty.",
    );
  });

  it('passes other AnkiConnect errors through unchanged', async () => {
    stubServers({}, [], 'model was not found: vocabsieve-notes-with-url');

    await expect(
      addFormattedNote('Russian', format, line, { audioText: '', language: 'ru' }),
    ).rejects.toThrow('AnkiConnect error: model was not found: vocabsieve-notes-with-url');
  });
});
