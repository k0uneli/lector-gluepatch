import '../test-guard';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import { invalidateDictionaryCache, lookupWord } from './dictionary-db';

const FIXTURE_DIR = path.resolve('.test-data', 'dict-lemma-fixture');
const previousDictDir = process.env.DICT_DIR;
const USER = 'lemma-fixture-user';

// Rows as kaikki ships them in the ru and el dictionaries.
const FIXTURES: Record<string, { senses: Array<[string, string, string]>; infl: string[][] }> = {
  ru: {
    senses: [
      ['слышать', 'verb', 'to hear'],
      ['слышать', 'verb', 'to smell, to feel (a smell)'],
      [
        'слышу',
        'verb',
        'first-person singular present indicative imperfective of слы́шать (slýšatʹ)',
      ],
      ['стать', 'verb', 'to become'],
      ['сталь', 'noun', 'steel'],
      ['стали', 'verb', 'plural past indicative of стать pf (statʹ)'],
      ['стали', 'noun', 'inflection of сталь (stalʹ):'],
      ['стали', 'noun', 'genitive/dative/prepositional singular'],
      ['застать', 'verb', 'to find, to catch'],
      ['кот', 'noun', 'tomcat'],
      ['лучше', 'adv', 'comparative degree of хоро́ший (xoróšij)'],
    ],
    infl: [
      ['слышу', 'слышать', 'first-person,present,singular'],
      ['стали', 'сталь', 'genitive'],
      ['стали', 'стать', 'masculine,past,plural'],
      ['застали', 'застать', 'past,plural'],
    ],
  },
  el: {
    senses: [
      ['λέω', 'verb', 'to say, tell'],
      ['λέει', 'verb', 'third-person singular present of λέω (léo)'],
    ],
    infl: [['λέει', 'λέω', 'present,singular,third-person']],
  },
};

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [language, { senses, infl }] of Object.entries(FIXTURES)) {
    const file = path.join(FIXTURE_DIR, `dictionary-${language}.db`);
    fs.rmSync(file, { force: true });
    const db = new Database(file);
    db.exec(`
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
    const entry = db.prepare('INSERT OR IGNORE INTO entries (word, rank) VALUES (?, ?)');
    const sense = db.prepare(
      'INSERT INTO senses (word, pos, gloss, sort_order) VALUES (?, ?, ?, ?)',
    );
    senses.forEach(([word, pos, gloss], i) => {
      entry.run(word, 10);
      sense.run(word, pos, gloss, i);
    });
    const row = db.prepare(
      'INSERT INTO inflections (inflected_form, lemma, type) VALUES (?, ?, ?)',
    );
    for (const [form, lemma, type] of infl) row.run(form, lemma, type);
    db.close();
  }
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

describe('form-of entries carry their lemma', () => {
  test('a form-of stub keeps its own senses and adds the lemma senses', () => {
    const entry = lookupWord(USER, 'слышу', 'ru');
    expect(entry?.word).toBe('слышу');
    expect(entry?.senses.map((s) => s.gloss)).toEqual([
      'first-person singular present indicative imperfective of слы́шать (slýšatʹ)',
    ]);
    expect(entry?.lemmaInfo).toBeUndefined();
    expect(entry?.lemmaEntries).toEqual([
      {
        word: 'слышать',
        senses: [
          { partOfSpeech: 'verb', gloss: 'to hear' },
          { partOfSpeech: 'verb', gloss: 'to smell, to feel (a smell)' },
        ],
      },
    ]);
  });

  test('a form of two lemmas lists both, in the order its glosses name them', () => {
    const entry = lookupWord(USER, 'стали', 'ru');
    expect(entry?.lemmaEntries?.map((l) => l.word)).toEqual(['стать', 'сталь']);
    expect(entry?.lemmaEntries?.map((l) => l.senses[0].gloss)).toEqual(['to become', 'steel']);
  });

  test('a lemma must appear as a whole word in the glosses', () => {
    // застали → застать is in the inflection table, but the entry is missing,
    // so the lookup resolves through the table and gets lemmaInfo instead.
    expect(lookupWord(USER, 'застали', 'ru')?.lemmaInfo?.stem).toBe('застать');
    // стать inside "застать" must not count as a mention.
    expect(lookupWord(USER, 'застать', 'ru')?.lemmaEntries).toBeUndefined();
  });

  test('an entry with no inflection-table lemma gets no lemma entries', () => {
    expect(lookupWord(USER, 'лучше', 'ru')?.lemmaEntries).toBeUndefined();
    expect(lookupWord(USER, 'кот', 'ru')?.lemmaEntries).toBeUndefined();
  });

  test('works for Greek, whose keys keep the tonos', () => {
    expect(lookupWord(USER, 'λέει', 'el')?.lemmaEntries?.[0]).toEqual({
      word: 'λέω',
      senses: [{ partOfSpeech: 'verb', gloss: 'to say, tell' }],
    });
  });
});

describe('Russian stress marks', () => {
  test('a stressed headword finds the unstressed key', () => {
    const entry = lookupWord(USER, 'слы́шать', 'ru');
    expect(entry?.word).toBe('слышать');
    expect(entry?.senses[0].gloss).toBe('to hear');
  });

  test('a stressed inflected form resolves too', () => {
    expect(lookupWord(USER, 'слы́шу', 'ru')?.lemmaEntries?.[0].word).toBe('слышать');
  });
});
