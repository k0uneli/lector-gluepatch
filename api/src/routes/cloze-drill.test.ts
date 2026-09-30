import '../test-guard';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { invalidateDictionaryCache } from '../lib/dictionary-db';

const FIXTURE_DIR = path.resolve('.test-data', 'dict-drill-fixture');
const previousDictDir = process.env.DICT_DIR;

const { default: app } = await import('./cloze');

function writeRussianDictionary() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const dbPath = path.join(FIXTURE_DIR, 'dictionary-ru.db');
  fs.rmSync(dbPath, { force: true });
  const dict = new Database(dbPath);
  dict.exec(`
    CREATE TABLE entries (word TEXT PRIMARY KEY, rank INTEGER, ipa TEXT, etymology TEXT);
    CREATE TABLE senses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL, pos TEXT, gloss TEXT NOT NULL, sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE related_forms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL, related_word TEXT NOT NULL, relation TEXT NOT NULL
    );
    CREATE TABLE inflections (
      inflected_form TEXT NOT NULL, lemma TEXT NOT NULL, type TEXT,
      PRIMARY KEY (inflected_form, lemma)
    );
  `);
  const entry = dict.prepare('INSERT INTO entries (word, rank) VALUES (?, ?)');
  const sense = dict.prepare('INSERT INTO senses (word, pos, gloss) VALUES (?, ?, ?)');
  const infl = dict.prepare(
    'INSERT INTO inflections (inflected_form, lemma, type) VALUES (?, ?, ?)',
  );
  const words: Array<[string, number, string]> = [
    ['так', 1, 'adv'],
    ['читать', 5, 'verb'],
    ['книга', 10, 'noun'],
    ['прочитать', 20, 'verb'],
    ['кот', 30, 'noun'],
    ['кошка', 40, 'noun'],
  ];
  for (const [word, rank, pos] of words) {
    entry.run(word, rank);
    sense.run(word, pos, word);
  }
  const rows: Array<[string, string, string]> = [
    ['книги', 'книга', 'genitive'],
    ['книг', 'книга', 'genitive,plural'],
    ['книжка', 'книга', 'diminutive'],
    ['книге', 'книга', 'dative,singular'],
    ['книгу', 'книга', 'accusative,singular'],
    ['книгой', 'книга', 'instrumental,singular'],
    ['прочитать', 'читать', 'perfective'],
    ['читал', 'читать', 'masculine,past,singular'],
    ['читали', 'читать', 'masculine,past,plural'],
    ['читала', 'читать', 'feminine,past,singular'],
    ['читать', 'прочитать', 'imperfective'],
    ['кошка', 'кот', 'feminine'],
  ];
  for (const row of rows) infl.run(...row);
  dict.close();
}

const CARDS = [
  { id: 'drill-kniga', sentence: 'Я читаю книгу.', clozeWord: 'книгу.', clozeIndex: 2 },
  { id: 'drill-chitala', sentence: 'Она читала весь день.', clozeWord: 'читала', clozeIndex: 1 },
  { id: 'drill-knig', sentence: 'У меня много книг.', clozeWord: 'книг.', clozeIndex: 3 },
  { id: 'drill-tak', sentence: 'Так нельзя.', clozeWord: 'Так', clozeIndex: 0 },
  { id: 'drill-koshka', sentence: 'Это моя кошка.', clozeWord: 'кошка.', clozeIndex: 2 },
].map((card) => ({
  ...card,
  translation: '-',
  language: 'ru',
  source: 'tatoeba',
  collection: 'top500',
  masteryLevel: 0,
  nextReview: '2020-01-01T00:00:00.000Z',
  reviewCount: 0,
  timesCorrect: 0,
  timesIncorrect: 0,
}));

const GREEK_CARD = {
  id: 'drill-spiti',
  sentence: 'Η πόρτα του σπιτιού.',
  clozeWord: 'σπιτιού.',
  clozeIndex: 3,
  language: 'el',
};

type DrillCard = {
  id: string;
  inflection?: {
    lemma: string;
    aspectPair: [string, string] | null;
    tags: string[];
    stem: string | null;
    ending: string | null;
    distractors: string[];
  };
};

async function due(query: string): Promise<DrillCard[]> {
  const res = await app.request(`/due?mode=new&collection=top500&${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as DrillCard[];
}

function reset() {
  const ids = [...CARDS.map((card) => card.id), GREEK_CARD.id];
  db.prepare(`DELETE FROM clozeSentences WHERE id IN (${ids.map(() => '?').join(',')})`).run(
    ...ids,
  );
}

beforeAll(() => {
  writeRussianDictionary();
  process.env.DICT_DIR = FIXTURE_DIR;
  invalidateDictionaryCache('ru');
  invalidateDictionaryCache('el');
});

afterAll(() => {
  if (previousDictDir === undefined) delete process.env.DICT_DIR;
  else process.env.DICT_DIR = previousDictDir;
  invalidateDictionaryCache('ru');
  invalidateDictionaryCache('el');
});

describe('GET /api/cloze/due?drill=', () => {
  beforeEach(async () => {
    reset();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CARDS),
    });
    expect(res.status).toBe(200);
  });
  afterEach(reset);

  test('the Ending drill serves only answers with a known ending', async () => {
    const cards = await due('language=ru&drill=ending');
    expect(cards.map((c) => c.id).sort()).toEqual(['drill-chitala', 'drill-kniga']);

    const kniga = cards.find((c) => c.id === 'drill-kniga')!.inflection!;
    expect(kniga.lemma).toBe('книга');
    expect(kniga.tags).toEqual(['accusative', 'singular']);
    expect(kniga.stem).toBe('книг');
    expect(kniga.ending).toBe('у');
    expect(kniga.aspectPair).toBeNull();
    expect(kniga.distractors).toHaveLength(3);
    expect(kniga.distractors).not.toContain('книжка');
    expect(kniga.distractors).not.toContain('книгу');
  });

  test('the Base form drill also serves forms with no ending, and pairs the aspects', async () => {
    const cards = await due('language=ru&drill=inflect');
    expect(cards.map((c) => c.id).sort()).toEqual(['drill-chitala', 'drill-knig', 'drill-kniga']);

    const chitala = cards.find((c) => c.id === 'drill-chitala')!.inflection!;
    expect(chitala.lemma).toBe('читать');
    expect(chitala.aspectPair).toEqual(['читать', 'прочитать']);
    expect(chitala.distractors).toEqual(expect.arrayContaining(['читал', 'читали']));
    expect(chitala.distractors).not.toContain('прочитать');
  });

  test('an uninflected word and a derived noun never enter a drill', async () => {
    const ids = (await due('language=ru&drill=inflect')).map((c) => c.id);
    expect(ids).not.toContain('drill-tak');
    expect(ids).not.toContain('drill-koshka');
  });

  test('the limit caps the eligible cards', async () => {
    expect(await due('language=ru&drill=inflect&limit=1')).toHaveLength(1);
  });

  test('without a drill the round is unfiltered and carries no inflection', async () => {
    const cards = await due('language=ru');
    expect(cards).toHaveLength(CARDS.length);
    expect(cards.every((c) => c.inflection === undefined)).toBe(true);
  });

  test('a drill on a language with no dictionary serves nothing', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ ...CARDS[0], ...GREEK_CARD }]),
    });
    expect(res.status).toBe(200);
    expect(await due('language=el')).toHaveLength(1);
    expect(await due('language=el&drill=ending')).toEqual([]);
  });
});
