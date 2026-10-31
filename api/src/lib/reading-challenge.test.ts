import '../test-guard';
import { describe, expect, test } from 'bun:test';
import { getLanguageConfig } from './languages';
import type { WordClass } from './dictionary-db';
import type { LLMProvider } from './llm';
import {
  buildReadingChallenge,
  buildReadingPrompt,
  CoverageMeter,
  selectWords,
  type KnownWord,
} from './reading-challenge';

const ru = getLanguageConfig('ru');

const LEMMAS: Record<string, string[]> = { кота: ['кот'], вижу: ['видеть'], доме: ['дом'] };
const GRAMMAR = new Set(['я', 'в', 'и']);
const classify = (words: readonly string[]) =>
  new Map<string, WordClass>(
    words.map((w) => [w, { key: w, lemmas: LEMMAS[w] ?? [], grammar: GRAMMAR.has(w) }]),
  );
const noDictionary = () => null;

const KNOWN: KnownWord[] = [
  { word: 'кот', state: 'level2' },
  { word: 'видеть', state: 'known' },
  { word: 'дом', state: 'level1' },
  { word: 'большой', state: 'known' },
  { word: 'слон', state: 'new' },
  { word: 'москва', state: 'ignored' },
];

function fakeProvider(...replies: unknown[]): LLMProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'fake',
    prompts,
    async complete(options) {
      prompts.push(options.messages.map((m) => m.content).join('\n'));
      return JSON.stringify(replies[Math.min(prompts.length - 1, replies.length - 1)]);
    },
  } as LLMProvider & { prompts: string[] };
}

describe('CoverageMeter', () => {
  test('counts inflected forms of known words and grammar words as known', () => {
    const meter = new CoverageMeter(KNOWN, ru, classify);
    expect(meter.measure('Я вижу кота в доме.')).toEqual({
      totalWords: 5,
      newWords: [],
      newPercent: 0,
    });
  });

  test('counts words in the new state as new, and ignored words as known', () => {
    const meter = new CoverageMeter(KNOWN, ru, classify);
    const coverage = meter.measure('Слон и Москва и слон.');
    expect(coverage.newWords).toEqual(['слон']);
    expect(coverage.totalWords).toBe(5);
    expect(coverage.newPercent).toBe(40);
  });

  test('compares surface forms when the language has no dictionary', () => {
    const meter = new CoverageMeter(KNOWN, ru, noDictionary);
    const coverage = meter.measure('Кот видеть кота.');
    expect(coverage.newWords).toEqual(['кота']);
    expect(coverage.newPercent).toBe(33.3);
  });

  test('an empty text has no new words', () => {
    expect(new CoverageMeter(KNOWN, ru, classify).measure('…')).toEqual({
      totalWords: 0,
      newWords: [],
      newPercent: 0,
    });
  });
});

describe('selectWords', () => {
  test('puts learning words first and leaves out new and ignored words', () => {
    const { allowed, focus } = selectWords(KNOWN, () => 0);
    expect(new Set(allowed.slice(0, 2))).toEqual(new Set(['кот', 'дом']));
    expect(new Set(allowed)).toEqual(new Set(['кот', 'дом', 'видеть', 'большой']));
    expect(new Set(focus)).toEqual(new Set(['кот', 'дом']));
  });
});

describe('buildReadingPrompt', () => {
  const base = {
    languageName: 'Russian',
    words: 200,
    allowed: ['кот', 'дом'],
    focus: ['кот'],
    avoidTitles: ['Кот дома'],
  };

  test('states the length, the share of new words and the lists', () => {
    const prompt = buildReadingPrompt({ ...base, newPercent: 5 });
    expect(prompt).toContain('about 200 words');
    expect(prompt).toContain('About 5% of the words (roughly 10 of 200)');
    expect(prompt).toContain('кот, дом');
    expect(prompt).toContain('- Кот дома');
  });

  test('forbids new words at 0%', () => {
    const prompt = buildReadingPrompt({ ...base, newPercent: 0 });
    expect(prompt).toContain('Use no other words.');
    expect(prompt).not.toContain('outside the list');
  });
});

describe('buildReadingChallenge', () => {
  const opts = { known: KNOWN, pack: ru, words: 100, newPercent: 5, avoidTitles: [] };

  test('keeps a draft that is close enough to the target', async () => {
    const provider = fakeProvider({ title: 'Кот', text: 'Я вижу кота в доме.' });
    const result = await buildReadingChallenge(
      provider,
      opts,
      new CoverageMeter(KNOWN, ru, classify),
    );
    expect(provider.prompts).toHaveLength(1);
    expect(result).toMatchObject({ title: 'Кот', newPercent: 0, totalWords: 5 });
  });

  test('revises a draft with too many new words and keeps the better one', async () => {
    const provider = fakeProvider(
      { title: 'Слон', text: 'Я вижу слона и жирафа.' },
      { title: '', text: 'Я вижу большой дом.' },
    );
    const result = await buildReadingChallenge(
      provider,
      opts,
      new CoverageMeter(KNOWN, ru, classify),
    );
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]).toContain('слона, жирафа');
    expect(result).toMatchObject({ title: 'Слон', text: 'Я вижу большой дом.', newPercent: 0 });
  });

  test('keeps the draft when the revision is worse', async () => {
    const provider = fakeProvider(
      { title: 'Слон', text: 'Я вижу слона.' },
      { title: 'Слон', text: 'Слона жирафа зебру.' },
    );
    const result = await buildReadingChallenge(
      provider,
      opts,
      new CoverageMeter(KNOWN, ru, classify),
    );
    expect(result?.text).toBe('Я вижу слона.');
  });

  test('returns null when the model sends no text', async () => {
    const provider = fakeProvider({ title: 'x' });
    expect(
      await buildReadingChallenge(provider, opts, new CoverageMeter(KNOWN, ru, classify)),
    ).toBeNull();
  });
});
