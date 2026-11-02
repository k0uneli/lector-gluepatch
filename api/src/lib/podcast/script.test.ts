import '../../test-guard';
import { describe, expect, test } from 'bun:test';
import type { WordClass } from '../dictionary-db';
import { getLanguageConfig } from '../languages';
import {
  assembleParagraph,
  buildScriptPrompt,
  describeEntry,
  episodeIntro,
  knownForPodcast,
  parseScriptNotes,
  parseTranslation,
  planSentences,
  UnknownWordFinder,
} from './script';

const ru = getLanguageConfig('ru');
const nl = getLanguageConfig('nl');
const noDictionary = () => null;

describe('knownForPodcast', () => {
  const known = [
    { word: 'a', state: 'new' as const },
    { word: 'b', state: 'level1' as const },
    { word: 'c', state: 'level2' as const },
    { word: 'd', state: 'level3' as const },
    { word: 'e', state: 'known' as const },
    { word: 'f', state: 'ignored' as const },
  ];

  test('level3 explains new, level1 and level2 words', () => {
    expect(knownForPodcast(known, 'level3').map((k) => k.word)).toEqual(['d', 'e', 'f']);
  });

  test('level1 explains only new words, and ignored words always count as known', () => {
    expect(knownForPodcast(known, 'level1').map((k) => k.word)).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(knownForPodcast(known, 'known').map((k) => k.word)).toEqual(['e', 'f']);
  });
});

describe('UnknownWordFinder', () => {
  test('without a dictionary, matches the folded surface forms', () => {
    const finder = new UnknownWordFinder([{ word: 'Кот', state: 'known' }], ru, noDictionary);
    expect(finder.find('Кот видит кота, кот видит дом.')).toEqual(['видит', 'кота', 'дом']);
  });

  test('with a dictionary, inflected forms of known words and grammar words count as known', () => {
    const classes = new Map<string, WordClass>([
      ['кот', { key: 'кот', lemmas: [], grammar: false }],
      ['кота', { key: 'кота', lemmas: ['кот'], grammar: false }],
      ['и', { key: 'и', lemmas: [], grammar: true }],
      ['видит', { key: 'видит', lemmas: ['видеть'], grammar: false }],
    ]);
    const classify = (words: readonly string[]) =>
      new Map(words.map((w) => [w, classes.get(w) ?? { key: w, lemmas: [], grammar: false }]));
    const finder = new UnknownWordFinder([{ word: 'кот', state: 'known' }], ru, classify);
    expect(finder.find('Кота и видит.')).toEqual(['видит']);
  });
});

describe('planSentences', () => {
  test('explains each word once, at its first sentence, and skips earlier paragraphs', () => {
    const finder = new UnknownWordFinder([], ru, noDictionary);
    const plans = planSentences(
      ['Кот видит дом.', 'Дом видит кот.', 'Сад.'],
      finder,
      new Set(['сад']),
      (word) => (word === 'дом' ? 'house' : null),
    );
    expect(plans).toEqual([
      {
        text: 'Кот видит дом.',
        words: [
          { word: 'кот', facts: null },
          { word: 'видит', facts: null },
          { word: 'дом', facts: 'house' },
        ],
      },
      { text: 'Дом видит кот.', words: [] },
      { text: 'Сад.', words: [] },
    ]);
  });
});

describe('describeEntry', () => {
  test('joins the form label, glosses and lemma glosses', () => {
    expect(
      describeEntry({
        word: 'слышу',
        senses: [{ partOfSpeech: 'verb', gloss: 'first-person singular present of слышать' }],
        lemmaInfo: { stem: 'слышать', label: 'first-person singular present of' },
        lemmaEntries: [{ word: 'слышать', senses: [{ partOfSpeech: 'verb', gloss: 'to hear' }] }],
      }),
    ).toBe(
      'first-person singular present of слышать — first-person singular present of слышать — слышать: to hear',
    );
  });

  test('is null without an entry', () => {
    expect(describeEntry(undefined)).toBeNull();
  });
});

describe('buildScriptPrompt', () => {
  test('lists every sentence with its words and dictionary facts', () => {
    const prompt = buildScriptPrompt({
      languageName: 'Russian',
      previous: 'Раньше.',
      sentences: [
        { text: 'Кот видит дом.', words: [{ word: 'видит', facts: 'to see' }] },
        { text: 'Дом большой.', words: [] },
      ],
    });
    expect(prompt).toContain('learning Russian');
    expect(prompt).toContain(
      '1. Кот видит дом.\n   Words to explain:\n   - видит (dictionary: to see)',
    );
    expect(prompt).toContain('2. Дом большой.\n   Words to explain: none');
    expect(prompt).toContain('for context only:\nРаньше.');
    expect(prompt).toContain('«guillemets»');
    expect(prompt).toContain('Give one translation.');
    expect(prompt).toContain('Do not give the dictionary form.');
    expect(prompt).toContain('You may name the grammatical form briefly');
    expect(prompt).toContain('{"translation": "...", "sentences"');
  });
});

describe('parseScriptNotes', () => {
  test('keeps valid notes per sentence, word notes first', () => {
    const notes = parseScriptNotes(
      {
        sentences: [
          {
            n: 1,
            notes: [
              { kind: 'grammar', say: 'Accusative case.' },
              { kind: 'word', say: '  «дом»   means house. ' },
            ],
          },
          { n: 2, notes: [{ kind: 'metaphor', say: 'A figure of speech.' }] },
        ],
      },
      2,
    );
    expect(notes).toEqual([
      [
        { kind: 'word', say: '«дом» means house.' },
        { kind: 'grammar', say: 'Accusative case.' },
      ],
      [{ kind: 'grammar', say: 'A figure of speech.' }],
    ]);
  });

  test('drops out-of-range sentences and malformed notes', () => {
    expect(
      parseScriptNotes(
        {
          sentences: [
            { n: 0, notes: [{ kind: 'word', say: 'x' }] },
            { n: 3, notes: [{ kind: 'word', say: 'x' }] },
            { n: 1.5, notes: [{ kind: 'word', say: 'x' }] },
            { n: 1, notes: [{ kind: 'word' }, { kind: 'word', say: '   ' }, 'text'] },
          ],
        },
        2,
      ),
    ).toEqual([[], []]);
    expect(parseScriptNotes('not json', 1)).toEqual([[]]);
  });

  test('caps a long note at a word boundary', () => {
    const [[note]] = parseScriptNotes(
      { sentences: [{ n: 1, notes: [{ say: 'word '.repeat(200) }] }] },
      1,
    );
    expect(note.say.length).toBeLessThanOrEqual(600);
    expect(note.say.endsWith('word')).toBe(true);
  });
});

describe('parseTranslation', () => {
  test('keeps the paragraph translation without guillemets', () => {
    expect(parseTranslation({ translation: '  The «cat»  sees a house. ' })).toBe(
      'The cat sees a house.',
    );
  });

  test('is null when the model gave none', () => {
    expect(parseTranslation({ sentences: [] })).toBeNull();
    expect(parseTranslation({ translation: '  ' })).toBeNull();
    expect(parseTranslation({ translation: 7 })).toBeNull();
    expect(parseTranslation('text')).toBeNull();
  });
});

describe('assembleParagraph', () => {
  test('reads each sentence slowly, adds its notes, then reads the whole paragraph', () => {
    const lines = assembleParagraph({
      number: 4,
      sentences: ['Кот видит дом.', 'Дом большой.'],
      notes: [[{ kind: 'word', say: '«видит» means sees.' }], []],
      translation: 'The cat sees the house. The house is big.',
      intro: 'Welcome.',
      outro: 'Bye.',
    });
    expect(lines).toEqual([
      { kind: 'intro', text: 'Welcome.' },
      { kind: 'heading', text: 'Paragraph 4.' },
      { kind: 'slow', text: 'Кот видит дом.' },
      { kind: 'note', text: '«видит» means sees.' },
      { kind: 'slow', text: 'Дом большой.' },
      { kind: 'heading', text: 'Now the whole paragraph.' },
      { kind: 'read', text: 'Кот видит дом.' },
      { kind: 'read', text: 'Дом большой.' },
      { kind: 'heading', text: 'In English.' },
      { kind: 'translation', text: 'The cat sees the house. The house is big.' },
      { kind: 'outro', text: 'Bye.' },
    ]);
  });

  test('names a later chunk of the paragraph as continued', () => {
    expect(
      assembleParagraph({ number: 2, continued: true, sentences: ['Да.'], notes: [[]] })[0],
    ).toEqual({ kind: 'heading', text: 'Paragraph 2, continued.' });
  });

  test('skips the re-read for a one-sentence paragraph, but not the translation', () => {
    expect(
      assembleParagraph({ number: 1, sentences: ['Да.'], notes: [[]] }).map((l) => l.kind),
    ).toEqual(['heading', 'slow']);
    expect(
      assembleParagraph({ number: 1, sentences: ['Да.'], notes: [[]], translation: 'Yes.' }).map(
        (l) => l.kind,
      ),
    ).toEqual(['heading', 'slow', 'heading', 'translation']);
  });
});

describe('episodeIntro', () => {
  test('wraps titles the target voice should read', () => {
    const intro = episodeIntro({
      pack: ru,
      sourceTitle: 'Глава 1',
      bookTitle: 'Chapter book',
      paraFrom: 3,
      paraTo: 9,
      wholeChapter: false,
    });
    expect(intro).toContain('we read «Глава 1», from Chapter book, paragraphs 3 to 9.');
  });

  test('wraps every title for a Latin-script language', () => {
    expect(
      episodeIntro({
        pack: nl,
        sourceTitle: 'Hoofdstuk',
        bookTitle: null,
        paraFrom: 1,
        paraTo: 5,
        wholeChapter: true,
      }),
    ).toContain('we read «Hoofdstuk». I read');
  });
});
