import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CONVERSATION_AUTOPLAY_KEY,
  CONVERSATION_NEW_PERCENT_KEY,
  CONVERSATION_VOICE_KEY,
  ConversationError,
  getConversationAutoplay,
  getConversationNewPercent,
  loadConversation,
  pickEngine,
  requestReply,
  saveConversation,
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
  test('default to 3% new words with replies read aloud', () => {
    expect(getConversationNewPercent()).toBe(3);
    expect(getConversationAutoplay()).toBe(true);
  });

  test('read stored values and ignore bad ones', () => {
    store.set(CONVERSATION_NEW_PERCENT_KEY, '0');
    store.set(CONVERSATION_AUTOPLAY_KEY, 'false');
    expect(getConversationNewPercent()).toBe(0);
    expect(getConversationAutoplay()).toBe(false);
    store.set(CONVERSATION_NEW_PERCENT_KEY, '25');
    expect(getConversationNewPercent()).toBe(3);
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

describe('saved conversations', () => {
  test('round-trip per language and clear', () => {
    const conversation = { topic: 'cats', messages: [{ role: 'user' as const, text: 'Привет' }] };
    saveConversation('ru', conversation);
    expect(loadConversation('ru')).toEqual(conversation);
    expect(loadConversation('el')).toBeNull();
    saveConversation('ru', null);
    expect(loadConversation('ru')).toBeNull();
  });

  test('ignore corrupt storage', () => {
    store.set('lector-conversation:ru', '{not json');
    expect(loadConversation('ru')).toBeNull();
  });
});

describe('requestReply', () => {
  test('sends roles and text only, and maps the reply', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ reply: 'Привет!', translation: 'Hi!', newPercent: 0, newWords: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const reply = await requestReply(
      [
        { role: 'assistant', text: 'Как дела?', translation: 'How are you?', newPercent: 0 },
        { role: 'user', text: 'Хорошо' },
      ],
      5,
      'weather',
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/conversation\/reply\?language=\w+$/);
    expect(JSON.parse(String(init.body))).toEqual({
      history: [
        { role: 'assistant', text: 'Как дела?' },
        { role: 'user', text: 'Хорошо' },
      ],
      newPercent: 5,
      topic: 'weather',
    });
    expect(reply).toEqual({ text: 'Привет!', translation: 'Hi!', newPercent: 0, newWords: [] });
  });

  test('keeps only the latest 40 turns', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ reply: 'x', translation: '', newPercent: 0, newWords: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const many = Array.from({ length: 45 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `t${i}`,
    }));
    await requestReply(many, 3, '');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const { history } = JSON.parse(String(init.body));
    expect(history).toHaveLength(40);
    expect(history.at(-1).text).toBe('t44');
  });

  test('turns an error response into a ConversationError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'No reply', code: 'NO_REPLY' }, { status: 502 })),
    );
    const error = await requestReply([], 3, '').catch((e) => e);
    expect(error).toBeInstanceOf(ConversationError);
    expect(error).toMatchObject({ message: 'No reply', code: 'NO_REPLY' });
  });
});
