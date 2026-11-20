import '../test-guard';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'path';
import { db } from '../db';
import { getTodayDate } from '../lib/dates';
import { invalidateDictionaryCache } from '../lib/dictionary-db';
import { writeInflectionDictionary } from '../test-fixtures/inflection-dictionary';
import app from './forms';

const FIXTURE_DIR = path.resolve('.test-data', 'dict-forms-fixture');
const previousDictDir = process.env.DICT_DIR;
const USER = 'local';

beforeAll(() => {
  writeInflectionDictionary(FIXTURE_DIR, 'ru', {
    senses: [
      ['книга', 'noun', 'book'],
      ['книги', 'noun', 'genitive singular of книга'],
      ['стол', 'noun', 'table'],
      ['читать', 'verb', 'to read'],
      ['так', 'adv', 'so'],
    ],
    inflections: [
      ['книги', 'книга', 'genitive'],
      ['книг', 'книга', 'genitive,plural'],
      ['книге', 'книга', 'dative,singular'],
      ['стола', 'стол', 'genitive,singular'],
      ['столы', 'стол', 'nominative,plural'],
      ['читаю', 'читать', 'first-person,present,singular'],
      ['читает', 'читать', 'present,singular,third-person'],
      ['так', 'така', 'genitive,plural'],
    ],
  });
  process.env.DICT_DIR = FIXTURE_DIR;
  invalidateDictionaryCache('ru');
});

afterAll(() => {
  if (previousDictDir === undefined) delete process.env.DICT_DIR;
  else process.env.DICT_DIR = previousDictDir;
  invalidateDictionaryCache('ru');
});

beforeEach(() => {
  for (const table of ['knownWords', 'clozeSentences', 'dailyStats']) {
    db.prepare(`DELETE FROM ${table} WHERE userId = ?`).run(USER);
  }
});

function markKnown(words: string[]) {
  const insert = db.prepare(
    `INSERT INTO knownWords (userId, word, language, state) VALUES (?, ?, 'ru', 'known')`,
  );
  for (const word of words) insert.run(USER, word);
}

const round = async (query: string) => {
  const res = await app.request(`/round?${query}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe('GET /round', () => {
  test('builds items from marked words, resolving forms to their lemma', async () => {
    markKnown(['книги', 'стол', 'читаю', 'так']);
    const { status, body } = await round('language=ru&kinds=noun&count=10');
    expect(status).toBe(200);
    const lemmas = body.items.map((i: { lemma: string }) => i.lemma).sort();
    expect(lemmas).toEqual(['книга', 'стол']);
    for (const item of body.items) {
      expect(item.kind).toBe('noun');
      expect(item.answers.length).toBeGreaterThan(0);
      expect(item.prompt).not.toBe('nominative singular');
      expect(item.paradigm.lemma).toBe(item.lemma);
    }
  });

  test('serves verbs, with the gloss of the headword', async () => {
    markKnown(['читаю']);
    const { body } = await round('language=ru&kinds=verb');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ lemma: 'читать', gloss: 'to read', kind: 'verb' });
    expect(['читаю', 'читает']).toContain(body.items[0].answers[0]);
  });

  test('tops up from the sentence bank', async () => {
    db.prepare(
      `INSERT INTO clozeSentences (id, userId, sentence, clozeWord, clozeIndex, translation, source, collection, wordRank, nextReview, language)
       VALUES ('fs-1', ?, 'Вот стол.', 'стол.', 1, 'Here is a table.', 'tatoeba', 'top500', 12, ?, 'ru')`,
    ).run(USER, new Date().toISOString());
    const { body } = await round('language=ru&kinds=noun');
    expect(body.items.map((i: { lemma: string }) => i.lemma)).toEqual(['стол']);
  });

  test('404s with a code when nothing can be drilled', async () => {
    const { status, body } = await round('language=ru&kinds=noun');
    expect(status).toBe(404);
    expect(body.code).toBe('NO_ITEMS');
  });

  test('refuses a language without the drill', async () => {
    const { status, body } = await round('language=af');
    expect(status).toBe(400);
    expect(body.code).toBe('NOT_SUPPORTED');
  });

  test.each(['kinds=adjective', 'kinds=', 'count=0', 'count=31', 'count=2.5'])(
    'rejects %s',
    async (query) => {
      expect((await round(`language=ru&${query}`)).status).toBe(400);
    },
  );
});

describe('POST /answer', () => {
  test('counts toward today’s practice', async () => {
    await app.request('/answer?language=ru', { method: 'POST' });
    await app.request('/answer?language=ru', { method: 'POST' });
    const row = db
      .prepare(
        'SELECT clozePracticed FROM dailyStats WHERE userId = ? AND date = ? AND language = ?',
      )
      .get(USER, getTodayDate(USER), 'ru') as { clozePracticed: number };
    expect(row.clozePracticed).toBe(2);
  });
});
