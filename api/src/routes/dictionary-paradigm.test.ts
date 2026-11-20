import '../test-guard';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'path';
import { invalidateDictionaryCache } from '../lib/dictionary-db';
import { writeInflectionDictionary } from '../test-fixtures/inflection-dictionary';
import { makeDictionaryRoutes } from './dictionary';

const FIXTURE_DIR = path.resolve('.test-data', 'dict-paradigm-fixture');
const previousDictDir = process.env.DICT_DIR;
const app = makeDictionaryRoutes(() => 'local');

beforeAll(() => {
  writeInflectionDictionary(FIXTURE_DIR, 'ru', {
    senses: [
      ['книга', 'noun', 'book', 300],
      ['книги', 'noun', 'genitive singular of книга'],
      ['читать', 'verb', 'to read', 200],
      ['стол', 'noun', 'table', 400],
      ['там', 'adv', 'there', 50],
    ],
    inflections: [
      ['книги', 'книга', 'genitive'],
      ['книг', 'книга', 'genitive,plural'],
      ['книге', 'книга', 'dative,singular'],
      ['читаю', 'читать', 'first-person,present,singular'],
      ['читает', 'читать', 'present,singular,third-person'],
      ['читал', 'читать', 'masculine,past,singular'],
      ['стола', 'стол', 'genitive,singular'],
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

const get = async (word: string, language = 'ru') => {
  const res = await app.request(
    `/paradigm?word=${encodeURIComponent(word)}&language=${language}`,
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe('GET /paradigm', () => {
  test('returns the table of a headword', async () => {
    const { status, body } = await get('книга');
    expect(status).toBe(200);
    expect(body.paradigm.lemma).toBe('книга');
    expect(body.paradigm.kind).toBe('noun');
    expect(body.paradigm.tables[0].rows[0]).toEqual({
      label: 'nominative',
      cells: [
        { tags: ['nominative', 'singular'], forms: ['книга'] },
        { tags: ['nominative', 'plural'], forms: [] },
      ],
    });
  });

  test('resolves an inflected form to its lemma', async () => {
    const { body } = await get('Книги');
    expect(body.paradigm.lemma).toBe('книга');
  });

  test('builds a conjugation for a verb form', async () => {
    const { body } = await get('читает');
    expect(body.paradigm.lemma).toBe('читать');
    expect(body.paradigm.tables.map((t: { title: string }) => t.title)).toEqual([
      'Present',
      'Past',
    ]);
  });

  test('is null for a word without a paradigm', async () => {
    expect((await get('там')).body).toEqual({ paradigm: null });
    expect((await get('нетслова')).body).toEqual({ paradigm: null });
  });

  test('is null for a language without a dictionary', async () => {
    expect((await get('huis', 'af')).body).toEqual({ paradigm: null });
  });

  test('requires a word', async () => {
    expect((await get('  ')).status).toBe(400);
  });
});
