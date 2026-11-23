import '../test-guard';
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'fs';
import { db } from '../db';
import { invalidateDictionaryCache } from '../lib/dictionary-db';
import * as actualLlm from '../lib/llm';

// Same delegating-mock pattern as recall.test.ts: bun module mocks are process-global.
const realGetProvider = actualLlm.getProvider as (...args: unknown[]) => unknown;
const calls: Array<Array<{ role: string; content: string }>> = [];
let replies: unknown[] = [];
let failNext = false;
const fakeProvider = {
  name: 'fake',
  async complete(options: { messages: Array<{ role: string; content: string }> }) {
    calls.push(options.messages);
    if (failNext) {
      failNext = false;
      throw new Error('provider down');
    }
    return JSON.stringify(replies[Math.min(calls.length - 1, replies.length - 1)]);
  },
};
let getProviderImpl: (...args: unknown[]) => unknown = () => fakeProvider;
mock.module('../lib/llm', () => ({
  ...actualLlm,
  getProvider: (...args: unknown[]) => getProviderImpl(...args),
}));

const { makeConversationRoutes } = await import('./conversation');
const { chatDir } = await import('../lib/conversation-store');
// Pass-through audio: decode keeps the bytes, encode returns the joined PCM.
const toolkit = {
  decode: async (audio: Uint8Array) => audio.slice(),
  encode: async (pcm: Uint8Array) => pcm.slice(),
};
const app = makeConversationRoutes('selfhost', toolkit);
const cloud = makeConversationRoutes('cloud', toolkit);

const USER = 'local';
const ENV_KEYS = [
  'PODCAST_TTS_URL',
  'PODCAST_TTS_VOICE',
  'PODCAST_TTS_ENGLISH_VOICE',
  'GOOGLE_CLOUD_API_KEY',
  'ELEVENLABS_API_KEY',
  'DICT_DIR',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const ttsRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeAll(() => {
  fs.mkdirSync('.test-data', { recursive: true });
  process.env.DICT_DIR = fs.mkdtempSync('.test-data/conversation-dict-');
  invalidateDictionaryCache('ru');
  process.env.PODCAST_TTS_URL = 'http://gpu.lan:8004';
  process.env.PODCAST_TTS_VOICE = 'ru';
  process.env.PODCAST_TTS_ENGLISH_VOICE = 'en';
  delete process.env.GOOGLE_CLOUD_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('http://gpu.lan')) return realFetch(input, init);
    ttsRequests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
  }) as typeof fetch;
});

afterAll(() => {
  getProviderImpl = realGetProvider;
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  invalidateDictionaryCache('ru');
});

beforeEach(() => {
  for (const table of ['knownWords', 'conversations', 'conversation_messages']) {
    db.prepare(`DELETE FROM ${table} WHERE userId = ?`).run(USER);
  }
  const insert = db.prepare(
    `INSERT INTO knownWords (userId, word, language, state) VALUES (?, ?, 'ru', ?)`,
  );
  for (const [word, state] of [
    ['привет', 'known'],
    ['как', 'known'],
    ['дела', 'level2'],
    ['слон', 'new'],
  ]) {
    insert.run(USER, word, state);
  }
  calls.length = 0;
  ttsRequests.length = 0;
  failNext = false;
  replies = [{ reply: 'Привет! Как дела?', translation: 'Hi! How are you?' }];
});

const post = (path: string, body: unknown, target = app) =>
  target.request(`${path}?language=ru`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const getJson = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

async function startChat(body: Record<string, unknown> = {}) {
  const res = await post('/chats', body);
  expect(res.status).toBe(201);
  return (await res.json()) as { chat: { id: string }; messages: Array<Record<string, any>> };
}

function turn(id: string, text: string, audio?: Uint8Array, newPercent?: string) {
  const form = new FormData();
  form.append('text', text);
  if (newPercent !== undefined) form.append('newPercent', newPercent);
  if (audio) form.append('audio', new Blob([audio as BlobPart]), 'turn.wav');
  return app.request(`/chats/${id}/turns?language=ru`, { method: 'POST', body: form });
}

describe('saved chats', () => {
  test('starting a chat saves the opening reply, measured', async () => {
    const started = await startChat({ newPercent: 5, topic: 'the weather' });
    expect(started.messages).toEqual([
      expect.objectContaining({
        idx: 0,
        role: 'assistant',
        text: 'Привет! Как дела?',
        translation: 'Hi! How are you?',
        newPercent: 0,
        newWords: [],
        hasAudio: false,
      }),
    ]);
    const system = calls[0][0].content;
    expect(system).toContain('At most 5% of the words');
    expect(system).toContain('The conversation is about: the weather.');
    expect(system).toContain('привет');
    expect(system).not.toContain('слон');
  });

  test('a turn stores the learner text and recording, then the reply', async () => {
    const { chat } = await startChat();
    calls.length = 0;
    replies = [{ reply: 'Привет, слон!', translation: 'Hi, elephant!' }];
    const res = await turn(chat.id, ' Привет ', new Uint8Array([7, 7, 7]), '20');
    expect(res.status).toBe(200);
    const { messages } = (await res.json()) as { messages: Array<Record<string, any>> };
    expect(messages.map((m) => [m.idx, m.role, m.text, m.hasAudio])).toEqual([
      [1, 'user', 'Привет', true],
      [2, 'assistant', 'Привет, слон!', false],
    ]);
    expect(messages[1]).toMatchObject({ newWords: ['слон'], newPercent: 50 });
    expect(calls[0].slice(1)).toEqual([
      { role: 'user', content: '(The learner has joined. Start the conversation.)' },
      { role: 'assistant', content: 'Привет! Как дела?' },
      { role: 'user', content: 'Привет' },
    ]);

    const audio = await app.request(`/chats/${chat.id}/messages/1/audio`);
    expect(audio.status).toBe(200);
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
    expect((await app.request(`/chats/${chat.id}/messages/2/audio`)).status).toBe(404);
  });

  test('a failed reply keeps the turn, and retrying answers it', async () => {
    const { chat } = await startChat();
    failNext = true;
    expect((await turn(chat.id, 'Привет')).status).toBe(502);
    const { body } = await getJson(`/chats/${chat.id}`);
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', text: 'Привет' });
    expect((await turn(chat.id, 'Ещё')).status).toBe(409);

    const retried = await post(`/chats/${chat.id}/reply`, {});
    expect(retried.status).toBe(200);
    expect((await retried.json()).messages[0].role).toBe('assistant');
    expect((await post(`/chats/${chat.id}/reply`, {})).status).toBe(409);
  });

  test('a failed opening reply leaves no chat behind', async () => {
    failNext = true;
    expect((await post('/chats', {})).status).toBe(502);
    expect((await getJson('/chats?language=ru')).body.chats).toEqual([]);
  });

  test('lists chats newest first with a preview, and deletes one with its files', async () => {
    const first = await startChat({ topic: 'food' });
    const second = await startChat();
    await turn(second.chat.id, 'Привет', new Uint8Array([1]));
    const { body } = await getJson('/chats?language=ru');
    expect(body.chats.map((c: { id: string }) => c.id)).toEqual([second.chat.id, first.chat.id]);
    expect(body.chats[1]).toMatchObject({ topic: 'food', preview: 'Привет! Как дела?', messageCount: 1 });
    expect((await getJson('/chats?language=el')).body.chats).toEqual([]);

    const dir = chatDir(second.chat.id);
    expect(fs.existsSync(dir)).toBe(true);
    expect((await app.request(`/chats/${second.chat.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await getJson(`/chats/${second.chat.id}`)).status).toBe(404);
    expect((await app.request(`/chats/${second.chat.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  test('another user cannot read or delete a chat', async () => {
    const { chat } = await startChat();
    db.prepare('UPDATE conversations SET userId = ? WHERE id = ?').run('someone-else', chat.id);
    db.prepare('UPDATE conversation_messages SET userId = ? WHERE conversationId = ?').run(
      'someone-else',
      chat.id,
    );
    expect((await getJson(`/chats/${chat.id}`)).status).toBe(404);
    expect((await app.request(`/chats/${chat.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await turn(chat.id, 'Привет')).status).toBe(404);
  });

  test('imports a conversation kept in the browser', async () => {
    const res = await post('/chats/import', {
      topic: 'cats',
      messages: [
        { role: 'assistant', text: 'Привет!', translation: 'Hi!', newPercent: 0, newWords: [] },
        { role: 'user', text: 'Привет' },
      ],
    });
    expect(res.status).toBe(201);
    const imported = await res.json();
    expect(imported.chat.topic).toBe('cats');
    expect(imported.messages.map((m: { role: string }) => m.role)).toEqual(['assistant', 'user']);
    expect(calls).toHaveLength(0);
    expect((await post('/chats/import', { messages: [{ role: 'system', text: 'x' }] })).status).toBe(400);
    expect((await post('/chats/import', { messages: [] })).status).toBe(400);
  });

  test.each([
    [{ newPercent: 21 }, 'newPercent'],
    [{ newPercent: '3' }, 'newPercent'],
    [{ topic: 'x'.repeat(201) }, 'topic'],
  ])('rejects a new chat with %p', async (body, message) => {
    const res = await post('/chats', body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['', 'text is required'],
    ['x'.repeat(1001), 'text is required'],
  ])('rejects a turn with text %p', async (text, message) => {
    const { chat } = await startChat();
    const res = await turn(chat.id, text);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
  });
});

describe('stitched recording', () => {
  test('joins the learner recordings and the partner voice in order', async () => {
    const { chat } = await startChat();
    replies = [{ reply: 'Отлично!', translation: 'Great!' }];
    await turn(chat.id, 'Привет', new Uint8Array([9, 9]));
    await turn(chat.id, 'Напечатано');

    const res = await post(`/chats/${chat.id}/recording`, { engine: 'local' });
    expect(res.status).toBe(200);
    const { recording } = await res.json();
    expect(recording.messages).toBe(5);
    // The second 'Отлично!' comes from the TTS cache.
    expect(ttsRequests.map((r) => r.body.input)).toEqual(['Привет! Как дела?', 'Отлично!']);

    const audio = new Uint8Array(await (await app.request(`/chats/${chat.id}/recording`)).arrayBuffer());
    const gap = (24_000 * 700) / 1000 * 2;
    const voice = [1, 2, 3];
    expect(Array.from(audio.slice(0, 3))).toEqual(voice);
    expect(Array.from(audio.slice(3 + gap, 3 + gap + 2))).toEqual([9, 9]);
    expect(audio.byteLength).toBe(3 + gap + 2 + gap + 3 + gap + 3);

    const { body } = await getJson('/chats?language=ru');
    expect(body.chats[0].recording).toEqual({ durationMs: recording.durationMs, messages: 5 });
  });

  test('needs a voice engine that is set up', async () => {
    const { chat } = await startChat();
    const res = await post(`/chats/${chat.id}/recording`, { engine: 'google' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('GOOGLE_CLOUD_API_KEY');
  });

  test('can be deleted while the chat stays', async () => {
    const { chat } = await startChat();
    await post(`/chats/${chat.id}/recording`, { engine: 'local' });
    const file = `${chatDir(chat.id)}/conversation.mp3`;
    expect(fs.existsSync(file)).toBe(true);
    expect((await app.request(`/chats/${chat.id}/recording`, { method: 'DELETE' })).status).toBe(200);
    expect(fs.existsSync(file)).toBe(false);
    expect((await app.request(`/chats/${chat.id}/recording`)).status).toBe(404);
    expect((await getJson(`/chats/${chat.id}`)).body.chat.recording).toBeNull();
    expect((await app.request(`/chats/${chat.id}/recording`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('GET /voices', () => {
  test('lists each engine and preselects one that works', async () => {
    const res = await app.request('/voices?language=ru');
    const body = await res.json();
    expect(body.engines.local).toEqual({ configured: true });
    expect(body.engines.google.configured).toBe(false);
    expect(body.defaultEngine).toBe('local');
  });

  test('offers only Google in cloud mode', async () => {
    const body = await (await cloud.request('/voices?language=ru')).json();
    expect(body.engines.local.configured).toBe(false);
    expect(body.defaultEngine).toBeNull();
  });
});

describe('POST /speak', () => {
  test('reads the text with the chosen engine and the target-language voice', async () => {
    const res = await post('/speak', { text: 'Привет!', engine: 'local' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(ttsRequests[0]).toEqual({
      url: 'http://gpu.lan:8004/v1/audio/speech',
      body: { input: 'Привет!', voice: 'ru', response_format: 'mp3' },
    });
  });

  test('refuses an engine that is not set up', async () => {
    const res = await post('/speak', { text: 'Привет!', engine: 'google' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('GOOGLE_CLOUD_API_KEY');
  });

  test.each([
    [{ engine: 'local' }, 'text is required'],
    [{ text: 'x'.repeat(1001), engine: 'local' }, 'at most 1000'],
    [{ text: 'Привет', engine: 'espeak' }, 'engine must be one of'],
  ])('rejects %p', async (body, message) => {
    const res = await post('/speak', body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
  });
});
