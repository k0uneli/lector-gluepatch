import '../test-guard';
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import * as actualLlm from '../lib/llm';
import { getTodayDate } from '../lib/dates';
import { invalidateDictionaryCache } from '../lib/dictionary-db';

// Same delegating-mock pattern as recall.test.ts: bun module mocks are process-global.
const realGetProvider = actualLlm.getProvider as (...args: unknown[]) => unknown;
const prompts: string[] = [];
let replies: unknown[] = [];
let failNext = false;
const fakeProvider = {
  name: 'fake',
  async complete(options: { messages: Array<{ content: string }> }) {
    prompts.push(options.messages.map((m) => m.content).join('\n'));
    if (failNext) {
      failNext = false;
      throw new Error('provider down');
    }
    return JSON.stringify(replies[Math.min(prompts.length - 1, replies.length - 1)]);
  },
};
let getProviderImpl: (...args: unknown[]) => unknown = () => fakeProvider;
mock.module('../lib/llm', () => ({
  ...actualLlm,
  getProvider: (...args: unknown[]) => getProviderImpl(...args),
}));
afterAll(() => {
  getProviderImpl = realGetProvider;
});

const { default: app, READING_COLLECTION_TITLE } = await import('./reading-challenge');

// An empty dictionary dir: coverage falls back to surface forms.
const FIXTURE_DIR = path.resolve('.test-data', 'dict-reading-fixture');
const previousDictDir = process.env.DICT_DIR;
const USER = 'local';
const WORDS = ['кот', 'видит', 'дом', 'большой', 'и', ...Array.from({ length: 30 }, (_, i) => `слово${i}`)];

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  process.env.DICT_DIR = FIXTURE_DIR;
  invalidateDictionaryCache('ru');
});

afterAll(() => {
  if (previousDictDir === undefined) delete process.env.DICT_DIR;
  else process.env.DICT_DIR = previousDictDir;
  invalidateDictionaryCache('ru');
});

function seedKnown(words: readonly string[] = WORDS) {
  const insert = db.prepare(
    `INSERT INTO knownWords (userId, word, language, state) VALUES (?, ?, 'ru', ?)`,
  );
  words.forEach((word, i) => insert.run(USER, word, i % 2 === 0 ? 'known' : 'level2'));
}

beforeEach(() => {
  for (const table of ['reading_challenges', 'lessons', 'collections', 'knownWords']) {
    db.prepare(`DELETE FROM ${table} WHERE userId = ?`).run(USER);
  }
  prompts.length = 0;
  failNext = false;
  replies = [{ title: 'Кот', text: 'Кот видит дом.\n\nБольшой кот и дом.' }];
});

const req = (method: string, url: string, body?: unknown) =>
  app.request(`${url}?language=ru`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

interface Challenge {
  day: string;
  lessonId: string;
  collectionId: string;
  title: string;
  wordCount: number;
  targetNewPercent: number;
  newPercent: number;
  newWords: string[];
  progress: number;
}

async function generate(body: unknown = {}) {
  const res = await req('POST', '/today', body);
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: Challenge }).challenge;
}

describe('reading challenge', () => {
  test('today is null until generated', async () => {
    const res = await req('GET', '/today');
    expect(await res.json()).toEqual({ day: getTodayDate(USER), challenge: null });
  });

  test('refuses to generate from too few marked words', async () => {
    seedKnown(WORDS.slice(0, 10));
    const res = await req('POST', '/today', {});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NOT_ENOUGH_VOCAB');
    expect(prompts).toHaveLength(0);
  });

  test.each([
    [{ words: 50 }, 'words'],
    [{ words: 1000 }, 'words'],
    [{ words: 150.5 }, 'words'],
    [{ newPercent: -1 }, 'newPercent'],
    [{ newPercent: 25 }, 'newPercent'],
    [{ newPercent: '5' }, 'newPercent'],
  ])('rejects %p', async (body, field) => {
    seedKnown();
    const res = await req('POST', '/today', body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(field);
    expect(prompts).toHaveLength(0);
  });

  test('writes the text into a Daily Reading lesson', async () => {
    seedKnown();
    const challenge = await generate({ words: 300, newPercent: 10 });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('about 300 words');
    expect(prompts[0]).toContain('About 10% of the words');
    expect(challenge).toMatchObject({
      day: getTodayDate(USER),
      title: 'Кот',
      targetNewPercent: 10,
      newPercent: 0,
      newWords: [],
      progress: 0,
    });
    expect(challenge.wordCount).toBeGreaterThan(0);

    const lesson = db
      .prepare('SELECT title, textContent, language, collectionId FROM lessons WHERE id = ?')
      .get(challenge.lessonId) as Record<string, string>;
    expect(lesson.title).toBe(`${challenge.day} · Кот`);
    expect(lesson.textContent).toBe('Кот видит дом.\n\nБольшой кот и дом.');
    expect(lesson.language).toBe('ru');
    const collection = db
      .prepare('SELECT title, language FROM collections WHERE id = ?')
      .get(lesson.collectionId) as Record<string, string>;
    expect(collection).toEqual({ title: READING_COLLECTION_TITLE, language: 'ru' });
  });

  test('reports the new words it measured', async () => {
    seedKnown();
    replies = [{ title: 'Слон', text: 'Кот видит слона.' }];
    const challenge = await generate({ newPercent: 20 });
    expect(challenge.newWords).toEqual(['слона']);
    expect(challenge.newPercent).toBe(33.3);
  });

  test('returns the existing text instead of writing another', async () => {
    seedKnown();
    const first = await generate();
    const second = await generate({ words: 500 });
    expect(second.lessonId).toBe(first.lessonId);
    expect(prompts).toHaveLength(1);
    const get = (await (await req('GET', '/today')).json()) as { challenge: Challenge };
    expect(get.challenge.lessonId).toBe(first.lessonId);
  });

  test('reuses the Daily Reading collection on later days', async () => {
    seedKnown();
    const first = await generate();
    db.prepare('UPDATE reading_challenges SET day = ? WHERE userId = ?').run('2020-01-01', USER);
    const second = await generate();
    expect(second.lessonId).not.toBe(first.lessonId);
    expect(second.collectionId).toBe(first.collectionId);
    expect(prompts[1]).toContain('- Кот');
  });

  test('drops a challenge whose lesson was deleted', async () => {
    seedKnown();
    const first = await generate();
    db.prepare('DELETE FROM lessons WHERE id = ?').run(first.lessonId);
    const res = await req('GET', '/today');
    expect(((await res.json()) as { challenge: unknown }).challenge).toBeNull();
    const second = await generate();
    expect(second.lessonId).not.toBe(first.lessonId);
  });

  test('a provider failure stores nothing', async () => {
    seedKnown();
    failNext = true;
    const res = await req('POST', '/today', {});
    expect(res.status).toBe(502);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE userId = ?').get(USER)).toEqual({
      n: 0,
    });
    expect((await generate()).title).toBe('Кот');
  });

  test('an empty reply is a 502', async () => {
    seedKnown();
    replies = [{ title: 'Кот', text: '' }];
    const res = await req('POST', '/today', {});
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('NO_TEXT');
  });
});
