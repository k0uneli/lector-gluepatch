import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CONVERSATION_AUTOPLAY_KEY,
  CONVERSATION_NEW_PERCENT_KEY,
  CONVERSATION_PAUSE_KEY,
  CONVERSATION_STOP_MODE_KEY,
  CONVERSATION_VOICE_KEY,
  ConversationError,
  createChat,
  getConversationAutoplay,
  getConversationNewPercent,
  getConversationPauseSeconds,
  getConversationStopMode,
  importBrowserConversation,
  pickEngine,
  sendTurn,
  type ConversationVoices,
} from '../conversation';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const voices = (configured: string[], defaultEngine: string | null): ConversationVoices =>
  ({
    engines: Object.fromEntries(
      ['google', 'local', 'elevenlabs'].map((id) => [id, { configured: configured.includes(id) }]),
    ),
    defaultEngine,
  }) as ConversationVoices;

describe('conversation settings', () => {
  test('default to 3% new words, replies read aloud and auto-stop', () => {
    expect(getConversationNewPercent()).toBe(3);
    expect(getConversationAutoplay()).toBe(true);
    expect(getConversationStopMode()).toBe('auto');
  });

  test('read stored values and ignore bad ones', () => {
    store.set(CONVERSATION_NEW_PERCENT_KEY, '0');
    store.set(CONVERSATION_AUTOPLAY_KEY, 'false');
    store.set(CONVERSATION_STOP_MODE_KEY, 'manual');
    expect(getConversationNewPercent()).toBe(0);
    expect(getConversationAutoplay()).toBe(false);
    expect(getConversationStopMode()).toBe('manual');
    store.set(CONVERSATION_NEW_PERCENT_KEY, '25');
    store.set(CONVERSATION_STOP_MODE_KEY, 'sometimes');
    expect(getConversationNewPercent()).toBe(3);
    expect(getConversationStopMode()).toBe('auto');
  });
});

describe('pause length', () => {
  test('defaults to 2.5 seconds and reads a stored value within 1 to 8', () => {
    expect(getConversationPauseSeconds()).toBe(2.5);
    store.set(CONVERSATION_PAUSE_KEY, '4.5');
    expect(getConversationPauseSeconds()).toBe(4.5);
    for (const bad of ['0.5', '9', 'long', '']) {
      store.set(CONVERSATION_PAUSE_KEY, bad);
      expect(getConversationPauseSeconds()).toBe(2.5);
    }
  });
});

describe('pickEngine', () => {
  test('uses the saved engine when it works, else the server default', () => {
    expect(pickEngine(null)).toBeNull();
    expect(pickEngine(voices(['google', 'local'], 'google'))).toBe('google');
    store.set(CONVERSATION_VOICE_KEY, 'local');
    expect(pickEngine(voices(['google', 'local'], 'google'))).toBe('local');
    expect(pickEngine(voices(['google'], 'google'))).toBe('google');
    store.set(CONVERSATION_VOICE_KEY, 'espeak');
    expect(pickEngine(voices([], null))).toBeNull();
  });
});

describe('requests', () => {
  test('a new chat sends the topic and the new-word limit', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ chat: { id: 'c1' }, language: 'af', messages: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await createChat('food', 5);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/conversation\/chats\?language=\w+$/);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ topic: 'food', newPercent: 5 });
  });

  test('a turn goes as multipart, with the recording when there is one', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ messages: [{ idx: 1 }, { idx: 2 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const added = await sendTurn('c1', 'Goed', 3, new Blob(['wav'], { type: 'audio/wav' }));
    expect(added).toEqual([{ idx: 1 }, { idx: 2 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/conversation\/chats\/c1\/turns\?language=\w+$/);
    const form = init?.body as FormData;
    expect(form.get('text')).toBe('Goed');
    expect(form.get('newPercent')).toBe('3');
    expect(form.get('audio')).toBeInstanceOf(Blob);

    await sendTurn('c1', 'Getik', 3, null);
    expect((fetchMock.mock.calls[1][1]?.body as FormData).get('audio')).toBeNull();
  });

  test('an error response becomes a ConversationError with its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'No reply', code: 'NO_REPLY' }, { status: 502 })),
    );
    const error = await sendTurn('c1', 'Goed', 3, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConversationError);
    expect(error).toMatchObject({ message: 'No reply', code: 'NO_REPLY' });
  });
});

describe('importBrowserConversation', () => {
  test('moves a browser conversation to the server, then forgets it', async () => {
    store.set(
      'lector-conversation:af',
      JSON.stringify({ topic: 'cats', messages: [{ role: 'assistant', text: 'Hallo' }] }),
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ chat: { id: 'c9' }, language: 'af', messages: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const imported = await importBrowserConversation('af');
    expect(imported?.chat.id).toBe('c9');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/conversation/chats/import');
    expect(JSON.parse(String(init?.body))).toEqual({
      topic: 'cats',
      messages: [{ role: 'assistant', text: 'Hallo' }],
    });
    expect(store.has('lector-conversation:af')).toBe(false);
  });

  test('runs once when called twice at the same time', async () => {
    store.set(
      'lector-conversation:af',
      JSON.stringify({ messages: [{ role: 'user', text: 'x' }] }),
    );
    const fetchMock = vi.fn(async () => Response.json({ chat: { id: 'c1' }, messages: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([
      importBrowserConversation('af'),
      importBrowserConversation('af'),
    ]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does nothing without a stored conversation, and keeps it when the save fails', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'down' }, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await importBrowserConversation('af')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    store.set(
      'lector-conversation:af',
      JSON.stringify({ messages: [{ role: 'user', text: 'x' }] }),
    );
    await expect(importBrowserConversation('af')).rejects.toBeInstanceOf(ConversationError);
    expect(store.has('lector-conversation:af')).toBe(true);
  });
});
