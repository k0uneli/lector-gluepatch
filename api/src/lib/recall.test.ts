import '../test-guard';
import { describe, expect, test } from 'bun:test';
import { getLanguageConfig } from './languages';
import type { WordClass } from './dictionary-db';
import type { LLMProvider } from './llm';
import {
  buildGenerationPrompt,
  gradeRecallAnswer,
  pickSentences,
  selectFocusWords,
  vocabChangesFor,
  VocabMatcher,
  type RecallVocab,
} from './recall';

const ru = getLanguageConfig('ru');

const vocab = (text: string, state: RecallVocab['state'] = 'level1'): RecallVocab => ({
  id: `v-${text}`,
  text,
  state,
});

// A tiny stand-in for the dictionary: inflected forms, and closed-class words.
const LEMMAS: Record<string, string[]> = { кота: ['кот'], видит: ['видеть'], вижу: ['видеть'] };
const GRAMMAR = new Set(['я', 'в', 'не', 'он', 'это']);
const classify = (words: readonly string[]) =>
  new Map<string, WordClass>(
    words.map((w) => [w, { key: w, lemmas: LEMMAS[w] ?? [], grammar: GRAMMAR.has(w) }]),
  );

function fakeProvider(reply: unknown): LLMProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'fake',
    prompts,
    async complete(options) {
      prompts.push(options.messages.map((m) => m.content).join('\n'));
      return JSON.stringify(reply);
    },
  } as LLMProvider & { prompts: string[] };
}

describe('selectFocusWords', () => {
  test('takes two learning words for every known word', () => {
    const pool = [
      ...Array.from({ length: 50 }, (_, i) => vocab(`learn${i}`, 'level2')),
      ...Array.from({ length: 50 }, (_, i) => vocab(`known${i}`, 'known')),
    ];
    const focus = selectFocusWords(pool, () => 0.5);
    expect(focus).toHaveLength(60);
    expect(focus.filter((v) => v.state === 'known')).toHaveLength(20);
  });

  test('uses everything when the vocab is small', () => {
    const pool = [vocab('кот'), vocab('дом', 'known')];
    expect(
      selectFocusWords(pool)
        .map((v) => v.text)
        .sort(),
    ).toEqual(['дом', 'кот']);
  });
});

describe('VocabMatcher and pickSentences', () => {
  const words = [vocab('кот'), vocab('видеть', 'level3'), vocab('дом', 'known')];
  const matcher = new VocabMatcher(words, ru, classify);

  test('counts inflected forms of vocab words and grammar words as known', () => {
    expect(matcher.analyse('Я вижу кота.')).toEqual({
      used: [words[1], words[0]],
      unknown: [],
    });
  });

  test('reports words that are neither vocab nor grammar', () => {
    expect(matcher.analyse('Он видит собаку.').unknown).toEqual(['собаку']);
  });

  test('keeps clean sentences first, then one-unknown sentences, and drops the rest', () => {
    const picked = pickSentences(
      [
        { english: 'He sees a dog.', reference: 'Он видит собаку.' },
        { english: 'I see the cat.', reference: 'Я вижу кота.' },
        {
          english: 'The big dog sees the small cat.',
          reference: 'Большая собака видит маленького кота.',
        },
        { english: 'It is a house.', reference: 'Это дом.' },
        { english: 'I see the cat.', reference: 'Я вижу кота!' },
        { english: 'It is I.', reference: 'Это я.' },
      ],
      matcher,
      3,
    );
    expect(picked.map((p) => p.english)).toEqual([
      'I see the cat.',
      'It is a house.',
      'He sees a dog.',
    ]);
    expect(picked[0].words).toEqual([
      { id: 'v-видеть', text: 'видеть' },
      { id: 'v-кот', text: 'кот' },
    ]);
  });

  test('accepts every word when the language has no dictionary', () => {
    const noDict = new VocabMatcher(words, ru, () => null);
    expect(noDict.analyse('Кот спит.')).toEqual({ used: [words[0]], unknown: [] });
  });
});

describe('vocabChangesFor', () => {
  const practised = [vocab('кот', 'level4'), vocab('видеть', 'known'), vocab('дом', 'level1')];

  test('a correct answer raises every practised word', () => {
    expect(vocabChangesFor(true, practised, [], ru)).toEqual([
      { id: 'v-кот', text: 'кот', from: 'level4', to: 'known' },
      { id: 'v-дом', text: 'дом', from: 'level1', to: 'level2' },
    ]);
  });

  test('a wrong answer lowers only the missed words', () => {
    expect(vocabChangesFor(false, practised, ['Видеть'], ru)).toEqual([
      { id: 'v-видеть', text: 'видеть', from: 'known', to: 'level4' },
    ]);
  });

  test('a wrong answer with no missed words lowers them all, never below level1', () => {
    expect(vocabChangesFor(false, practised, [], ru)).toEqual([
      { id: 'v-кот', text: 'кот', from: 'level4', to: 'level3' },
      { id: 'v-видеть', text: 'видеть', from: 'known', to: 'level4' },
    ]);
  });
});

describe('prompts and parsing', () => {
  test('the generation prompt lists vocab, focus words and sentences to avoid', () => {
    const prompt = buildGenerationPrompt({
      languageName: 'Russian',
      allowed: ['кот', 'дом'],
      focus: ['кот'],
      count: 12,
      avoid: ['I see the cat.'],
    });
    expect(prompt).toContain('Write 12 short');
    expect(prompt).toContain('Vocabulary list:\nкот, дом');
    expect(prompt).toContain('Focus list:\nкот');
    expect(prompt).toContain('- I see the cat.');
  });

  test('grading drops malformed notes and keeps the verdict', async () => {
    const provider = fakeProvider({
      correct: false,
      corrected: 'Я вижу кота.',
      notes: [{ original: 'кот', corrected: 'кота', explanation: 'Accusative.' }, { original: 1 }],
      missed: ['кот', 5],
    });
    const grade = await gradeRecallAnswer(provider, {
      languageName: 'Russian',
      english: 'I see the cat.',
      reference: 'Я вижу кота.',
      answer: 'Я вижу кот.',
      words: ['кот', 'видеть'],
    });
    expect(grade).toEqual({
      correct: false,
      corrected: 'Я вижу кота.',
      notes: [{ original: 'кот', corrected: 'кота', explanation: 'Accusative.' }],
      missed: ['кот'],
    });
    expect(provider.prompts[0]).toContain("The student's Russian translation:\nЯ вижу кот.");
  });

  test('a non-boolean verdict counts as incorrect', async () => {
    const grade = await gradeRecallAnswer(fakeProvider({ correct: 'yes' }), {
      languageName: 'Russian',
      english: 'I see.',
      reference: 'Я вижу.',
      answer: 'Я вижу.',
      words: [],
    });
    expect(grade.correct).toBe(false);
    expect(grade.corrected).toBe('Я вижу.');
  });
});
