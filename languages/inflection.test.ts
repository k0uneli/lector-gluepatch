import { describe, it, expect } from 'vitest';

import {
  aspectPair,
  baseFormPrompt,
  describeForm,
  formatInflectionTags,
  isDistinctForm,
  isInflectionType,
  matchInitialCase,
  pickDistractors,
  readsAsOwnWord,
  splitEnding,
  supportsInflectionDrills,
  type InflectionRow,
} from './inflection';
import { LANGUAGES } from './registry';

const { ru, el, zh } = LANGUAGES;

// Rows as the kaikki build stores them in dictionary-ru.db.
const KNIGA: InflectionRow[] = [
  { form: 'книги', type: 'genitive' },
  { form: 'книг', type: 'genitive,plural' },
  { form: 'книжный', type: 'adjective,relational' },
  { form: 'книжка', type: 'diminutive' },
  { form: 'книге', type: 'dative,singular' },
  { form: 'книгам', type: 'dative,plural' },
  { form: 'книгу', type: 'accusative,singular' },
  { form: 'книгой', type: 'instrumental,singular' },
  { form: 'книгою', type: 'instrumental,singular' },
  { form: 'книгами', type: 'instrumental,plural' },
  { form: 'книгах', type: 'plural,prepositional' },
  { form: 'книгъ', type: 'dated,genitive,plural' },
];

describe('isInflectionType', () => {
  it('accepts grammatical tag lists', () => {
    expect(isInflectionType('accusative,singular', ['noun'])).toBe(true);
    expect(
      isInflectionType('active,indicative,past,perfective,singular,third-person', ['verb']),
    ).toBe(true);
    expect(isInflectionType('past', ['verb'])).toBe(true);
  });

  it('rejects links between headwords and respellings', () => {
    expect(isInflectionType('perfective', ['verb'])).toBe(false);
    expect(isInflectionType('diminutive', ['noun'])).toBe(false);
    expect(isInflectionType('unaccented', ['noun'])).toBe(false);
    expect(isInflectionType('ё-spelling', ['adj'])).toBe(false);
    expect(isInflectionType('dated,genitive,plural', ['noun'])).toBe(false);
    expect(isInflectionType(null, ['noun'])).toBe(false);
  });

  it('accepts a bare gender tag only where gender agrees', () => {
    expect(isInflectionType('feminine', ['adj'])).toBe(true);
    expect(isInflectionType('feminine', ['noun'])).toBe(false);
  });
});

describe('splitEnding', () => {
  it('splits Russian case and conjugation endings', () => {
    expect(splitEnding('книгу', 'книга', ru)).toEqual({ stem: 'книг', ending: 'у' });
    expect(splitEnding('говорит', 'говорить', ru)).toEqual({ stem: 'говор', ending: 'ит' });
    expect(splitEnding('читала', 'читать', ru)).toEqual({ stem: 'чита', ending: 'ла' });
    expect(splitEnding('могла', 'мочь', ru)).toEqual({ stem: 'мог', ending: 'ла' });
    expect(splitEnding('учился', 'учиться', ru)).toEqual({ stem: 'учи', ending: 'лся' });
  });

  it('keeps the most stem the lemma shares, even when a longer ending matches', () => {
    expect(splitEnding('дела', 'дело', ru)).toEqual({ stem: 'дел', ending: 'а' });
    expect(splitEnding('стола', 'стол', ru)).toEqual({ stem: 'стол', ending: 'а' });
    expect(splitEnding('Некоторые', 'некоторый', ru)).toEqual({ stem: 'Некотор', ending: 'ые' });
    expect(splitEnding('синие', 'синий', ru)).toEqual({ stem: 'син', ending: 'ие' });
    expect(splitEnding('деятельности', 'деятельность', ru)).toEqual({
      stem: 'деятельност',
      ending: 'и',
    });
    expect(splitEnding('читаете', 'читать', ru)).toEqual({ stem: 'чита', ending: 'ете' });
  });

  it('splits a Greek accusative spelled inside its nominative', () => {
    expect(splitEnding('κόσμο', 'κόσμος', el)).toEqual({ stem: 'κόσμ', ending: 'ο' });
    expect(splitEnding('πατέρα', 'πατέρας', el)).toEqual({ stem: 'πατέρ', ending: 'α' });
  });

  it('leaves a zero-ending form spelled inside its lemma unsplit', () => {
    expect(splitEnding('минут', 'минута', ru)).toBeNull();
    expect(splitEnding('дел', 'дело', ru)).toBeNull();
    expect(splitEnding('готов', 'готовый', ru)).toBeNull();
    expect(splitEnding('говорит', 'говорить', ru)).toEqual({ stem: 'говор', ending: 'ит' });
  });

  it('keeps the surface case of the stem', () => {
    expect(splitEnding('Книгу', 'книга', ru)).toEqual({ stem: 'Книг', ending: 'у' });
  });

  it('matches Greek endings whatever the stress', () => {
    expect(splitEnding('σπιτιού', 'σπίτι', el)).toEqual({ stem: 'σπιτι', ending: 'ού' });
    expect(splitEnding('έγραψε', 'γράφω', el)).toEqual({ stem: 'έγραψ', ending: 'ε' });
    expect(splitEnding('γράφοντας', 'γράφω', el)).toEqual({ stem: 'γράφ', ending: 'οντας' });
    expect(splitEnding('καλής', 'καλός', el)).toEqual({ stem: 'καλ', ending: 'ής' });
  });

  it('leaves at least two letters of stem', () => {
    expect(splitEnding('πάνε', 'πηγαίνω', el)).toEqual({ stem: 'πάν', ending: 'ε' });
  });

  it('returns null when no ending matches or the pack has none', () => {
    expect(splitEnding('είναι', 'είμαι', el)).toBeNull();
    expect(splitEnding('我们', '我', zh)).toBeNull();
  });
});

describe('isDistinctForm', () => {
  it('treats a mark-stripped alias as the lemma itself', () => {
    expect(isDistinctForm('σπιτι', 'σπίτι', el)).toBe(false);
    expect(isDistinctForm('σπιτιού', 'σπίτι', el)).toBe(true);
    expect(isDistinctForm('Книга', 'книга', ru)).toBe(false);
  });
});

describe('aspectPair', () => {
  it('reads the partner from either side of the link', () => {
    expect(aspectPair('читать', [{ form: 'прочитать', type: 'perfective' }])).toEqual([
      'читать',
      'прочитать',
    ]);
    expect(
      aspectPair('прочитать', [
        { form: 'читать', type: 'imperfective' },
        { form: 'прочитал', type: 'masculine,past,singular' },
      ]),
    ).toEqual(['читать', 'прочитать']);
    expect(aspectPair('книга', KNIGA)).toBeNull();
  });
});

describe('pickDistractors', () => {
  const noRandom = () => 0;
  const kniga = (answer: string, answerType: string) => ({
    answer,
    answerType,
    lemma: 'книга',
    lemmaPos: ['noun'],
    paradigm: KNIGA,
  });

  it('prefers forms sharing the answer tags, then offers the lemma', () => {
    const picked = pickDistractors(kniga('книгу', 'accusative,singular'), ru, { random: noRandom });
    expect(picked).toEqual(['книге', 'книгой', 'книга']);
  });

  it('skips derivations and dated spellings', () => {
    const picked = pickDistractors(kniga('книгу', 'accusative,singular'), ru, { count: 20 });
    expect(picked).not.toContain('книжка');
    expect(picked).not.toContain('книжный');
    expect(picked).not.toContain('книгъ');
  });

  it('never offers a second spelling of the answer cell', () => {
    const picked = pickDistractors(kniga('книгой', 'instrumental,singular'), ru, { count: 20 });
    expect(picked).not.toContain('книгою');
    expect(picked).not.toContain('книгой');
  });

  it('drops Greek unaccented aliases and romanizations', () => {
    const paradigm: InflectionRow[] = [
      { form: 'γράφει', type: 'active,imperfective,indicative,present,singular,third-person' },
      { form: 'έγραφε', type: 'active,imperfect,imperfective,indicative,singular,third-person' },
      { form: 'εγραφε', type: 'active,imperfect,imperfective,indicative,singular,third-person' },
      { form: 'γράψει', type: 'active,dependent,indicative,perfective,singular,third-person' },
      { form: "γράφ'", type: 'active,imperative,perfective,second-person,singular' },
      { form: 'grafo', type: 'active,present' },
    ];
    const picked = pickDistractors(
      {
        answer: 'έγραψε',
        answerType: 'active,indicative,past,perfective,singular,third-person',
        lemma: 'γράφω',
        lemmaPos: ['verb'],
        paradigm,
      },
      el,
      { random: noRandom },
    );
    expect(picked).toEqual(['γράψει', 'γράφει', 'έγραφε']);
  });

  it('writes a distractor with е when the answer does', () => {
    const paradigm: InflectionRow[] = [
      { form: 'идёт', type: 'present,singular,third-person' },
      { form: 'идет', type: 'present,singular,third-person' },
    ];
    const source = { lemma: 'идти', lemmaPos: ['verb'], paradigm };
    const one = { count: 1 };
    expect(
      pickDistractors(
        { ...source, answer: 'иду', answerType: 'first-person,present,singular' },
        ru,
        one,
      ),
    ).toEqual(['идет']);
    expect(
      pickDistractors(
        { ...source, answer: 'идём', answerType: 'first-person,plural,present' },
        ru,
        one,
      ),
    ).toEqual(['идёт']);
  });

  it('ranks forms on the same stem first in the Ending drill', () => {
    const paradigm: InflectionRow[] = [
      { form: 'шёл', type: 'masculine,past,singular' },
      { form: 'идут', type: 'plural,present,third-person' },
    ];
    const picked = pickDistractors(
      {
        answer: 'идёт',
        answerType: 'present,singular,third-person',
        lemma: 'идти',
        lemmaPos: ['verb'],
        paradigm,
      },
      ru,
      { stem: 'ид', count: 1 },
    );
    expect(picked).toEqual(['идут']);
  });

  it('keeps a homograph noun out of a verb answer', () => {
    const paradigm: InflectionRow[] = [
      { form: 'статями', type: 'instrumental,plural' },
      { form: 'стал', type: 'masculine,past,singular' },
    ];
    const picked = pickDistractors(
      {
        answer: 'стали',
        answerType: 'masculine,past,plural',
        lemma: 'стать',
        lemmaPos: ['verb', 'noun'],
        paradigm,
      },
      ru,
      { count: 2 },
    );
    expect(picked.sort()).toEqual(['стал', 'стать']);
  });

  it('keeps comparatives out unless the answer is one', () => {
    const paradigm: InflectionRow[] = [
      { form: 'νεότερο', type: 'comparative,neuter' },
      { form: 'νέα', type: 'feminine' },
    ];
    const picked = pickDistractors(
      { answer: 'νέο', answerType: 'neuter', lemma: 'νέος', lemmaPos: ['adj'], paradigm },
      el,
      { count: 2 },
    );
    expect(picked.sort()).toEqual(['νέα', 'νέος']);
  });
});

describe('readsAsOwnWord', () => {
  it('flags a form that is also an adverb or particle', () => {
    expect(
      readsAsOwnWord(
        [
          { pos: 'adv', gloss: 'so; in the negative: that (to a high degree)' },
          { pos: 'noun', gloss: 'genitive plural of та́ка (táka)' },
        ],
        ['noun'],
      ),
    ).toBe(true);
  });

  it('flags a headword whose part of speech the lemma lacks', () => {
    expect(
      readsAsOwnWord(
        [
          { pos: 'noun', gloss: 'day' },
          { pos: 'verb', gloss: 'second-person singular imperative of деть (detʹ)' },
        ],
        ['verb'],
      ),
    ).toBe(true);
  });

  it('keeps a form whose own sense shares the lemma part of speech', () => {
    expect(
      readsAsOwnWord(
        [
          { pos: 'noun', gloss: 'people, humans' },
          { pos: 'noun', gloss: 'nominative plural of челове́к (čelovék)' },
        ],
        ['noun'],
      ),
    ).toBe(false);
  });

  it('treats the cells under an inflection-of sense as form-of', () => {
    expect(
      readsAsOwnWord(
        [
          { pos: 'noun', gloss: 'inflection of сталь (stalʹ):' },
          { pos: 'noun', gloss: 'genitive/dative/prepositional singular' },
        ],
        ['verb'],
      ),
    ).toBe(false);
  });
});

describe('describeForm', () => {
  it('reads a single form-of gloss, ignoring stress marks', () => {
    expect(
      describeForm([{ pos: 'noun', gloss: 'accusative singular of кни́га (kníga)' }], 'книга', ru),
    ).toBe('accusative singular');
  });

  it('joins the cells listed under an inflection-of sense', () => {
    const senses = [
      { pos: 'num', gloss: 'inflection of оди́н (odín):' },
      { pos: 'num', gloss: 'dative plural' },
      { pos: 'num', gloss: 'instrumental masculine/neuter singular' },
    ];
    expect(describeForm(senses, 'один', ru)).toBe(
      'dative plural or instrumental masculine/neuter singular',
    );
  });

  it('keeps only the senses of the chosen lemma', () => {
    const senses = [
      { pos: 'verb', gloss: 'plural past indicative of стать pf (statʹ)' },
      { pos: 'noun', gloss: 'inflection of сталь (stalʹ):' },
      { pos: 'noun', gloss: 'genitive/dative/prepositional singular' },
    ];
    expect(describeForm(senses, 'стать', ru)).toBe('plural past indicative');
    expect(describeForm(senses, 'сталь', ru)).toBe('genitive/dative/prepositional singular');
  });

  it('names the Greek simple past the aorist', () => {
    expect(
      describeForm(
        [{ pos: 'verb', gloss: 'third-person singular simple past of γράφω (gráfo)' }],
        'γράφω',
        el,
      ),
    ).toBe('third-person singular aorist');
  });

  it('returns null without a form-of sense', () => {
    expect(describeForm([{ pos: 'adv', gloss: 'almost, nearly' }], 'почитать', ru)).toBeNull();
  });
});

describe('formatInflectionTags', () => {
  it('orders the tags the way a grammar names the form', () => {
    expect(formatInflectionTags(['accusative', 'singular'])).toBe('accusative singular');
    expect(formatInflectionTags(['present', 'singular', 'third-person'])).toBe(
      'third-person singular present',
    );
    expect(formatInflectionTags(['adverbial', 'participle', 'past'])).toBe(
      'past adverbial participle',
    );
  });

  it('names the Greek past perfective as the aorist', () => {
    expect(
      formatInflectionTags([
        'active',
        'indicative',
        'past',
        'perfective',
        'singular',
        'third-person',
      ]),
    ).toBe('third-person singular aorist indicative active');
    expect(
      formatInflectionTags(['active', 'imperfect', 'imperfective', 'indicative', 'singular']),
    ).toBe('singular imperfect indicative active');
  });
});

describe('baseFormPrompt', () => {
  it('shows the aspect pair when there is one', () => {
    expect(baseFormPrompt({ lemma: 'читать', aspectPair: ['читать', 'прочитать'] })).toBe(
      'читать / прочитать',
    );
    expect(baseFormPrompt({ lemma: 'γράφω', aspectPair: null })).toBe('γράφω');
  });
});

describe('matchInitialCase', () => {
  it('capitalises a distractor only when the answer is capitalised', () => {
    expect(matchInitialCase('книге', 'Книгу', ru)).toBe('Книге');
    expect(matchInitialCase('Книге', 'книгу', ru)).toBe('книге');
    expect(matchInitialCase('έχω', 'Έχει', el)).toBe('Έχω');
  });
});

describe('supportsInflectionDrills', () => {
  it('is on for the packs that ship endings', () => {
    expect(supportsInflectionDrills(ru)).toBe(true);
    expect(supportsInflectionDrills(el)).toBe(true);
    expect(supportsInflectionDrills(zh)).toBe(false);
  });
});
