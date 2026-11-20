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
const app = makeConversationRoutes('selfhost');
const cloud = makeConversationRoutes('cloud');

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
  db.prepare('DELETE FROM knownWords WHERE userId = ?').run(USER);
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

describe('POST /reply', () => {
  test('opens the conversation with words the learner knows', async () => {
    const res = await post('/reply', { newPercent: 5, topic: 'the weather' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      reply: 'Привет! Как дела?',
      translation: 'Hi! How are you?',
      newPercent: 0,
      newWords: [],
    });
    const system = calls[0][0].content;
    expect(system).toContain('At most 5% of the words');
    expect(system).toContain('The conversation is about: the weather.');
    expect(system).toContain('привет');
    expect(system).not.toContain('слон');
  });

  test('reports new words in the reply', async () => {
    replies = [{ reply: 'Привет, слон!', translation: 'Hi, elephant!' }];
    const res = await post('/reply', {
      history: [{ role: 'user', text: 'Привет' }],
      newPercent: 20,
    });
    expect(await res.json()).toMatchObject({ newWords: ['слон'], newPercent: 50 });
  });

  test('sends the history after the system prompt', async () => {
    await post('/reply', {
      history: [
        { role: 'user', text: 'Привет' },
        { role: 'assistant', text: 'Как дела?' },
        { role: 'user', text: ' Хорошо ' },
      ],
    });
    expect(calls[0].slice(1)).toEqual([
      { role: 'user', content: 'Привет' },
      { role: 'assistant', content: 'Как дела?' },
      { role: 'user', content: 'Хорошо' },
    ]);
  });

  test.each([
    [{ history: 'hi' }, 'history must be an array'],
    [{ history: [{ role: 'system', text: 'x' }] }, 'role of user or assistant'],
    [{ history: [{ role: 'user', text: '   ' }] }, 'role of user or assistant'],
    [{ history: [{ role: 'user', text: 'x'.repeat(1001) }] }, 'at most 1000 characters'],
    [{ history: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] }, 'last turn'],
    [{ history: Array.from({ length: 41 }, () => ({ role: 'user', text: 'a' })) }, 'at most 40 turns'],
    [{ newPercent: 21 }, 'newPercent'],
    [{ newPercent: '3' }, 'newPercent'],
    [{ topic: 'x'.repeat(201) }, 'topic'],
  ])('rejects %p', async (body, message) => {
    const res = await post('/reply', body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
    expect(calls).toHaveLength(0);
  });

  test('a provider failure is a 502', async () => {
    failNext = true;
    const res = await post('/reply', {});
    expect(res.status).toBe(502);
  });

  test('an empty reply is a 502 with a code', async () => {
    replies = [{ translation: 'x' }];
    const res = await post('/reply', {});
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('NO_REPLY');
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
