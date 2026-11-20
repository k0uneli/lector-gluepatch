import { describe, expect, it } from 'vitest';

import { buildParadigm, type Paradigm } from './paradigm';
import { getLanguageConfig } from './registry';

const ru = getLanguageConfig('ru');
const el = getLanguageConfig('el');

const rows = (pairs: Array<[string, string]>) => pairs.map(([form, type]) => ({ form, type }));

function grid(p: Paradigm | null, title = ''): Record<string, string[]> {
  const table = p?.tables.find((t) => t.title === title);
  if (!table) throw new Error(`no table "${title}"`);
  return Object.fromEntries(
    table.rows.map((r) => [r.label, r.cells.map((c) => c.forms.join('/') || '—')]),
  );
}

describe('buildParadigm: nouns', () => {
  const книга = rows([
    ['книги', 'genitive'],
    ['книг', 'genitive,plural'],
    ['книжный', 'adjective,relational'],
    ['книжка', 'diminutive'],
    ['книге', 'dative,singular'],
    ['книгам', 'dative,plural'],
    ['книгу', 'accusative,singular'],
    ['книгой', 'instrumental,singular'],
    ['книгою', 'instrumental,singular'],
    ['книгами', 'instrumental,plural'],
    ['книгах', 'plural,prepositional'],
    ['книгъ', 'dated,genitive,plural'],
  ]);

  it('lays out cases by number, with the headword as nominative singular', () => {
    const p = buildParadigm('книга', ['noun'], книга, ru);
    expect(p?.kind).toBe('noun');
    expect(p?.tables[0].columns).toEqual(['singular', 'plural']);
    expect(grid(p)).toEqual({
      nominative: ['книга', '—'],
      genitive: ['книги', 'книг'],
      dative: ['книге', 'книгам'],
      accusative: ['книгу', '—'],
      instrumental: ['книгой/книгою', 'книгами'],
      prepositional: ['—', 'книгах'],
    });
  });

  it('names each cell by its tags', () => {
    const p = buildParadigm('книга', ['noun'], книга, ru);
    const dative = p?.tables[0].rows.find((r) => r.label === 'dative');
    expect(dative?.cells.map((c) => c.tags)).toEqual([
      ['dative', 'singular'],
      ['dative', 'plural'],
    ]);
  });

  it('reads a bare plural as nominative plural and drops unaccented duplicates', () => {
    const p = buildParadigm(
      'άνθρωπος',
      ['noun'],
      rows([
        ['άνθρωποι', 'plural'],
        ['ανθρώπου', 'genitive,singular'],
        ['ανθρωπου', 'genitive,singular'],
        ['ανθρωποσ', 'unaccented'],
        ['ανθρωποι', 'plural'],
      ]),
      el,
    );
    expect(grid(p)).toEqual({
      nominative: ['άνθρωπος', 'άνθρωποι'],
      genitive: ['ανθρώπου', '—'],
    });
  });

  it('keeps ё over е in one cell', () => {
    const p = buildParadigm(
      'день',
      ['noun'],
      rows([
        ['дня', 'genitive'],
        ['днём', 'instrumental,singular'],
        ['днем', 'instrumental,singular'],
      ]),
      ru,
    );
    expect(grid(p).instrumental).toEqual(['днём']);
  });
});

describe('buildParadigm: adjectives', () => {
  it('lays out cases by gender, with degree forms beside the table', () => {
    const p = buildParadigm(
      'большой',
      ['adj'],
      rows([
        ['больший', 'comparative'],
        ['наибольший', 'superlative'],
        ['большое', 'neuter,nominative'],
        ['большая', 'feminine,nominative'],
        ['большие', 'nominative,plural'],
        ['большого', 'genitive,masculine,neuter'],
        ['большую', 'accusative,feminine'],
        ['велик', 'masculine,short-form'],
        ['велики', 'plural,short-form'],
      ]),
      ru,
    );
    expect(p?.kind).toBe('adjective');
    expect(p?.tables[0].columns).toEqual(['masculine', 'feminine', 'neuter', 'plural']);
    expect(grid(p)).toEqual({
      nominative: ['большой', 'большая', 'большое', 'большие'],
      genitive: ['большого', '—', 'большого', '—'],
      accusative: ['—', 'большую', '—', '—'],
      'short form': ['велик', '—', '—', 'велики'],
    });
    expect(p?.other).toEqual([
      { label: 'comparative', forms: ['больший'] },
      { label: 'superlative', forms: ['наибольший'] },
    ]);
  });

  it('splits plural columns by gender when the language does', () => {
    const p = buildParadigm(
      'καλός',
      ['adj'],
      rows([
        ['καλή', 'feminine'],
        ['καλό', 'neuter'],
        ['καλοί', 'masculine,nominative,plural'],
        ['καλές', 'feminine,nominative,plural'],
      ]),
      el,
    );
    expect(p?.tables[0].columns).toEqual([
      'masculine singular',
      'feminine singular',
      'neuter singular',
      'masculine plural',
      'feminine plural',
    ]);
    expect(grid(p).nominative).toEqual(['καλός', 'καλή', 'καλό', 'καλοί', 'καλές']);
  });
});

describe('buildParadigm: verbs', () => {
  const читать = rows([
    ['прочитать', 'perfective'],
    ['читающий', 'active,participle,present'],
    ['читая', 'adverbial,participle,present'],
    ['читаю', 'first-person,present,singular'],
    ['читаешь', 'present,second-person,singular'],
    ['читает', 'present,singular,third-person'],
    ['читаем', 'first-person,plural,present'],
    ['читаете', 'plural,present,second-person'],
    ['читают', 'plural,present,third-person'],
    ['читай', 'imperative,second-person,singular'],
    ['читайте', 'imperative,plural,second-person'],
    ['читал', 'masculine,past,singular'],
    ['читали', 'masculine,past,plural'],
    ['читала', 'feminine,past,singular'],
    ['читало', 'neuter,past,singular'],
    ['читаетъ', 'dated,present,singular,third-person'],
  ]);

  it('builds one table per tense, in tense order', () => {
    const p = buildParadigm('читать', ['verb'], читать, ru);
    expect(p?.kind).toBe('verb');
    expect(p?.tables.map((t) => t.title)).toEqual(['Present', 'Past', 'Imperative']);
    expect(grid(p, 'Present')).toEqual({
      '1st person': ['читаю', 'читаем'],
      '2nd person': ['читаешь', 'читаете'],
      '3rd person': ['читает', 'читают'],
    });
    expect(grid(p, 'Past')).toEqual({
      masculine: ['читал'],
      feminine: ['читала'],
      neuter: ['читало'],
      plural: ['читали'],
    });
    expect(grid(p, 'Imperative')).toEqual({ '2nd person': ['читай', 'читайте'] });
  });

  it('lists participles beside the tables', () => {
    const p = buildParadigm('читать', ['verb'], читать, ru);
    expect(p?.other).toEqual([
      { label: 'present active participle', forms: ['читающий'] },
      { label: 'present adverbial participle', forms: ['читая'] },
    ]);
  });

  it('tags finite cells with tense, person and number', () => {
    const p = buildParadigm('читать', ['verb'], читать, ru);
    expect(p?.tables[0].rows[0].cells[1].tags).toEqual(['present', 'first-person', 'plural']);
  });

  it('places a Greek headword and a bare past row, and ignores register tags', () => {
    const p = buildParadigm(
      'γράφω',
      ['verb'],
      rows([
        ['έγραψα', 'past'],
        ['γράφεις', 'active,imperfective,indicative,present,second-person,singular'],
        ['γράφομε', 'active,first-person,imperfective,indicative,plural,present,rare'],
        ['γράφουμε', 'active,first-person,imperfective,indicative,plural,present'],
        ['έγραψες', 'active,indicative,past,perfective,second-person,singular'],
        ['γράφεται', 'imperfective,indicative,passive,present,singular,third-person'],
      ]),
      el,
    );
    expect(p?.tables.map((t) => t.title)).toEqual([
      'Present imperfective active',
      'Present imperfective passive',
      'Aorist active',
    ]);
    expect(grid(p, 'Present imperfective active')).toEqual({
      '1st person': ['γράφω', 'γράφομε/γράφουμε'],
      '2nd person': ['γράφεις', '—'],
    });
    expect(grid(p, 'Aorist active')).toEqual({
      '1st person': ['έγραψα'],
      '2nd person': ['έγραψες'],
    });
  });
});

describe('buildParadigm: no table', () => {
  it('is null for a word with only derived forms', () => {
    expect(
      buildParadigm('книжка', ['noun'], rows([['книжечка', 'diminutive']]), ru),
    ).toBeNull();
  });

  it('is null for a single cell', () => {
    expect(buildParadigm('там', ['adv'], rows([]), ru)).toBeNull();
  });
});
