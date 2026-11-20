import '../test-guard';
import { describe, expect, test } from 'bun:test';
import { buildFormsRound, drillCells, pickItem } from './forms-drill';
import { getLanguageConfig, type Paradigm } from './languages';

const ru = getLanguageConfig('ru');

function noun(lemma: string): Paradigm {
  return {
    lemma,
    kind: 'noun',
    partsOfSpeech: ['noun'],
    other: [],
    tables: [
      {
        title: '',
        columns: ['singular', 'plural'],
        rows: [
          {
            label: 'nominative',
            cells: [
              { tags: ['nominative', 'singular'], forms: [lemma] },
              { tags: ['nominative', 'plural'], forms: [] },
            ],
          },
          {
            label: 'genitive',
            cells: [
              { tags: ['genitive', 'singular'], forms: [`${lemma}а`] },
              { tags: ['genitive', 'plural'], forms: [`${lemma}ов`] },
            ],
          },
        ],
      },
    ],
  };
}

function verb(lemma: string): Paradigm {
  return {
    lemma,
    kind: 'verb',
    partsOfSpeech: ['verb'],
    other: [],
    tables: [
      {
        title: 'Present',
        columns: ['singular'],
        rows: [
          {
            label: '1st person',
            cells: [{ tags: ['present', 'first-person', 'singular'], forms: [`${lemma}ю`] }],
          },
        ],
      },
    ],
  };
}

const sequence = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('drillCells', () => {
  test('skips empty cells and the headword', () => {
    expect(drillCells(noun('стол'), ru).map((c) => c.tags)).toEqual([
      ['genitive', 'singular'],
      ['genitive', 'plural'],
    ]);
  });
});

describe('pickItem', () => {
  test('names the cell in words and lists its forms', () => {
    expect(pickItem(noun('стол'), 'table', ru, () => 0.9)).toMatchObject({
      lemma: 'стол',
      gloss: 'table',
      kind: 'noun',
      tags: ['genitive', 'plural'],
      prompt: 'genitive plural',
      answers: ['столов'],
    });
  });

  test('skips adjectives and tables with nothing to ask', () => {
    expect(pickItem({ ...noun('большой'), kind: 'adjective' }, 'big', ru, Math.random)).toBeNull();
    const bare = noun('стол');
    bare.tables[0].rows = bare.tables[0].rows.slice(0, 1);
    expect(pickItem(bare, 'table', ru, Math.random)).toBeNull();
  });
});

describe('buildFormsRound', () => {
  const paradigms: Record<string, Paradigm> = {
    стола: noun('стол'),
    стол: noun('стол'),
    дом: noun('дом'),
    читаю: verb('читать'),
    знаю: verb('знать'),
    большой: { ...noun('большой'), kind: 'adjective', partsOfSpeech: ['adj'] },
    там: noun('там'),
  };
  paradigms.там.partsOfSpeech = ['adv'];
  const resolve = (w: string) => paradigms[w] ?? null;
  const gloss = (lemma: string) => (lemma === 'дом' ? null : `${lemma} gloss`);

  test('keeps each lemma once and only the asked kinds', () => {
    const items = buildFormsRound({
      words: ['стола', 'стол', 'читаю', 'большой'],
      kinds: ['noun'],
      count: 10,
      pack: ru,
      random: sequence([0]),
      resolve,
      gloss,
    });
    expect(items.map((i) => i.lemma)).toEqual(['стол']);
  });

  test('mixes kinds evenly up to the count', () => {
    const items = buildFormsRound({
      words: ['стола', 'читаю', 'знаю'],
      kinds: ['noun', 'verb'],
      count: 2,
      pack: ru,
      random: sequence([0]),
      resolve,
      gloss,
    });
    expect(items.map((i) => i.kind).sort()).toEqual(['noun', 'verb']);
  });

  test('skips headwords of another part of speech and headwords without a gloss', () => {
    const items = buildFormsRound({
      words: ['там', 'дом', 'стол'],
      kinds: ['noun'],
      count: 10,
      pack: ru,
      random: sequence([0]),
      resolve,
      gloss,
    });
    expect(items.map((i) => i.lemma)).toEqual(['стол']);
  });

  test('is empty when nothing resolves', () => {
    expect(
      buildFormsRound({ words: ['нет'], kinds: ['verb'], count: 5, pack: ru, resolve, gloss }),
    ).toEqual([]);
  });
});
