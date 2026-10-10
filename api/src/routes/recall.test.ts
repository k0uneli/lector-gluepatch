import '../test-guard';
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import * as actualLlm from '../lib/llm';
import { getTodayDate } from '../lib/dates';
import { invalidateDictionaryCache } from '../lib/dictionary-db';

// Same delegating-mock pattern as chat.test.ts: bun module mocks are process-global.
const realGetProvider = actualLlm.getProvider as (...args: unknown[]) => unknown;
const prompts: string[] = [];
let generationReply: unknown = {};
let gradeReply: unknown = {};
let failNext = false;
const fakeProvider = {
  name: 'fake',
  async complete(options: { messages: Array<{ content: string }> }) {
    const prompt = options.messages.map((m) => m.content).join('\n');
    prompts.push(prompt);
    if (failNext) {
      failNext = false;
      throw new Error('provider down');
    }
    return JSON.stringify(prompt.includes('grading') ? gradeReply : generationReply);
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

const { default: app } = await import('./recall');

const FIXTURE_DIR = path.resolve('.test-data', 'dict-recall-fixture');
const previousDictDir = process.env.DICT_DIR;
const USER = 'local';
const VOCAB = [
  ['кот', 'level1'],
  ['видеть', 'level4'],
  ['дом', 'known'],
  ['собака', 'level2'],
  ['большой', 'level3'],
] as const;

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, 'dictionary-ru.db');
  fs.rmSync(file, { force: true });
  const dict = new Database(file);
  dict.exec(`
    CREATE TABLE entries (word TEXT PRIMARY KEY, rank INTEGER, ipa TEXT, etymology TEXT);
    CREATE TABLE senses (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL, pos TEXT,
      gloss TEXT NOT NULL, sort_order INTEGER DEFAULT 0);
    CREATE TABLE related_forms (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL,
      related_word TEXT NOT NULL, relation TEXT NOT NULL);
    CREATE TABLE inflections (inflected_form TEXT NOT NULL, lemma TEXT NOT NULL, type TEXT,
      PRIMARY KEY (inflected_form, lemma));
  `);
  const senses: Array<[string, string, string]> = [
    ['кот', 'noun', 'tomcat'],
    ['видеть', 'verb', 'to see'],
    ['дом', 'noun', 'house'],
    ['собака', 'noun', 'dog'],
    ['большой', 'adj', 'big'],
    ['я', 'pron', 'I'],
    ['в', 'prep', 'in'],
    ['быть', 'verb', 'to be'],
  ];
  for (const [word, pos, gloss] of senses) {
    dict.prepare('INSERT OR IGNORE INTO entries (word) VALUES (?)').run(word);
    dict.prepare('INSERT INTO senses (word, pos, gloss) VALUES (?, ?, ?)').run(word, pos, gloss);
  }
  for (const [form, lemma] of [
    ['кота', 'кот'],
    ['вижу', 'видеть'],
    ['доме', 'дом'],
    ['был', 'быть'],
  ]) {
    dict.prepare('INSERT INTO inflections VALUES (?, ?, ?)').run(form, lemma, 'form');
  }
  dict.close();
  process.env.DICT_DIR = FIXTURE_DIR;
  invalidateDictionaryCache('ru');
});

afterAll(() => {
  if (previousDictDir === undefined) delete process.env.DICT_DIR;
  else process.env.DICT_DIR = previousDictDir;
  invalidateDictionaryCache('ru');
});

function seedVocab(rows: ReadonlyArray<readonly [string, string]> = VOCAB) {
  const now = new Date().toISOString();
  for (const [text, state] of rows) {
    db.prepare(
      `INSERT INTO vocab (userId, id, text, type, sentence, translation, state, stateUpdatedAt, language, createdAt)
       VALUES (?, ?, ?, 'word', '', '', ?, ?, 'ru', ?)`,
    ).run(USER, `v-${text}`, text, state, now, now);
    db.prepare(`INSERT INTO knownWords (userId, word, language, state) VALUES (?, ?, 'ru', ?)`).run(
      USER,
      text,
      state,
    );
  }
}

beforeEach(() => {
  for (const table of ['recall_items', 'vocab', 'knownWords', 'dailyStats']) {
    db.prepare(`DELETE FROM ${table} WHERE userId = ?`).run(USER);
  }
  prompts.length = 0;
  failNext = false;
  generationReply = {
    sentences: [
      { english: 'I see the cat.', translation: 'Я вижу кота.' },
      { english: 'The cat was in the house.', translation: 'Кот был в доме.' },
      { english: 'The dog is reading.', translation: 'Собака читает.' },
      { english: 'The elephant swims and sings.', translation: 'Слон плавает и поёт.' },
    ],
  };
  gradeReply = { correct: true, corrected: 'Я вижу кота.', notes: [], missed: [] };
});

const req = (method: string, url: string, body?: unknown) =>
  app.request(`${url}${url.includes('?') ? '&' : '?'}language=ru`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const state = (text: string) =>
  (
    db.prepare('SELECT state FROM vocab WHERE userId = ? AND text = ?').get(USER, text) as {
      state: string;
    }
  ).state;
const knownState = (text: string) =>
  (
    db.prepare('SELECT state FROM knownWords WHERE userId = ? AND word = ?').get(USER, text) as {
      state: string;
    }
  ).state;

async function generate(count = 10) {
  const res = await req('POST', '/today', { count });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    day: string;
    items: Array<{ idx: number; english: string; reference: string | null; words: string[] }>;
  };
}

describe('recall challenge', () => {
  test('today is empty until generated', async () => {
    const res = await req('GET', '/today');
    expect(await res.json()).toEqual({ day: getTodayDate(USER), items: [] });
  });

  test('refuses to generate from too little vocab', async () => {
    seedVocab(VOCAB.slice(0, 2));
    const res = await req('POST', '/today', {});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NOT_ENOUGH_VOCAB');
    expect(prompts).toHaveLength(0);
  });

  test('rejects a count out of range', async () => {
    seedVocab();
    expect((await req('POST', '/today', { count: 0 })).status).toBe(400);
    expect((await req('POST', '/today', { count: 31 })).status).toBe(400);
    expect((await req('POST', '/today', { count: 2.5 })).status).toBe(400);
  });

  test('keeps sentences built from vocab and grammar words, hiding the reference', async () => {
    seedVocab();
    const { day, items } = await generate();
    expect(day).toBe(getTodayDate(USER));
    expect(items.map((i) => i.english)).toEqual([
      'I see the cat.',
      'The cat was in the house.',
      'The dog is reading.',
    ]);
    expect(items[0].words.sort()).toEqual(['видеть', 'кот']);
    expect(items[1].words.sort()).toEqual(['дом', 'кот']);
    expect(items.every((i) => i.reference === null)).toBe(true);
    expect(prompts[0]).toContain('Write 15 short');
    expect(prompts[0]).toContain('собака');
  });

  test('a second request returns the same set without calling the AI', async () => {
    seedVocab();
    const first = await generate();
    const second = await generate(3);
    expect(second.items).toEqual(first.items);
    expect(prompts).toHaveLength(1);
  });

  test('a provider failure reports an error and stores nothing', async () => {
    seedVocab();
    failNext = true;
    const res = await req('POST', '/today', {});
    expect(res.status).toBe(502);
    expect((await (await req('GET', '/today')).json()).items).toEqual([]);
  });

  test('no usable sentences reports an error', async () => {
    seedVocab();
    generationReply = {
      sentences: [{ english: 'The elephant sings.', translation: 'Слон поёт громко.' }],
    };
    const res = await req('POST', '/today', {});
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('NO_SENTENCES');
  });
});

describe('answering', () => {
  test('a correct answer raises the practised words and counts as practice', async () => {
    seedVocab();
    const { day } = await generate();
    const res = await req('POST', `/${day}/0/answer`, { answer: 'Я вижу кота.' });
    expect(res.status).toBe(200);
    const item = await res.json();
    expect(item).toMatchObject({
      answer: 'Я вижу кота.',
      correct: true,
      aiCorrect: true,
      reference: 'Я вижу кота.',
    });
    expect(state('кот')).toBe('level2');
    expect(state('видеть')).toBe('known');
    expect(knownState('кот')).toBe('level2');
    expect(item.vocabChanges).toEqual(
      expect.arrayContaining([
        { text: 'кот', from: 'level1', to: 'level2' },
        { text: 'видеть', from: 'level4', to: 'known' },
      ]),
    );
    const stats = db
      .prepare(
        'SELECT clozePracticed FROM dailyStats WHERE userId = ? AND date = ? AND language = ?',
      )
      .get(USER, day, 'ru') as { clozePracticed: number };
    expect(stats.clozePracticed).toBe(1);
    expect(prompts[1]).toContain("The student's Russian translation:\nЯ вижу кота.");
  });

  test('a wrong answer lowers the missed word only', async () => {
    seedVocab();
    const { day } = await generate();
    gradeReply = { correct: false, corrected: 'Я вижу кота.', notes: [], missed: ['кот'] };
    const item = await (await req('POST', `/${day}/0/answer`, { answer: 'Я вижу кот.' })).json();
    expect(item.correct).toBe(false);
    expect(state('кот')).toBe('level1');
    expect(state('видеть')).toBe('level4');
  });

  test('overriding the verdict reverses the level moves', async () => {
    seedVocab();
    const { day } = await generate();
    await req('POST', `/${day}/0/answer`, { answer: 'Я вижу кота.' });
    expect(state('видеть')).toBe('known');

    const wrong = await (await req('PUT', `/${day}/0/verdict`, { correct: false })).json();
    expect(wrong).toMatchObject({ correct: false, aiCorrect: true });
    expect(state('видеть')).toBe('level3');
    expect(state('кот')).toBe('level1');

    const right = await (await req('PUT', `/${day}/0/verdict`, { correct: true })).json();
    expect(right.correct).toBe(true);
    expect(state('видеть')).toBe('known');
    expect(state('кот')).toBe('level2');
  });

  test('giving up reveals the answer without calling the AI', async () => {
    seedVocab();
    const { day } = await generate();
    const item = await (await req('POST', `/${day}/1/answer`, { giveUp: true })).json();
    expect(item).toMatchObject({
      answer: '',
      correct: false,
      aiCorrect: null,
      reference: 'Кот был в доме.',
    });
    expect(prompts).toHaveLength(1);
    expect(state('дом')).toBe('level4');
  });

  test('a sentence can be answered once', async () => {
    seedVocab();
    const { day } = await generate();
    await req('POST', `/${day}/0/answer`, { answer: 'Я вижу кота.' });
    const again = await req('POST', `/${day}/0/answer`, { answer: 'Я вижу кота.' });
    expect(again.status).toBe(409);
    expect(state('кот')).toBe('level2');
  });

  test('a grading failure leaves the sentence unanswered', async () => {
    seedVocab();
    const { day } = await generate();
    failNext = true;
    expect((await req('POST', `/${day}/0/answer`, { answer: 'Я вижу кота.' })).status).toBe(502);
    expect(state('кот')).toBe('level1');
    expect((await req('POST', `/${day}/0/answer`, { answer: 'Я вижу кота.' })).status).toBe(200);
  });

  test('only today can be answered, and bad params are rejected', async () => {
    seedVocab();
    await generate();
    expect((await req('POST', '/2020-01-01/0/answer', { answer: 'x' })).status).toBe(409);
    expect((await req('POST', '/not-a-day/0/answer', { answer: 'x' })).status).toBe(400);
    expect((await req('POST', `/${getTodayDate(USER)}/99/answer`, { answer: 'x' })).status).toBe(
      404,
    );
    expect((await req('PUT', `/${getTodayDate(USER)}/0/verdict`, { correct: true })).status).toBe(
      409,
    );
    expect((await req('PUT', `/${getTodayDate(USER)}/0/verdict`, { correct: 'yes' })).status).toBe(
      400,
    );
  });
});
