import '../test-guard';
import { describe, expect, test } from 'bun:test';
import type { WordClass } from './dictionary-db';
import { getLanguageConfig } from './languages';
import type { LLMProvider } from './llm';
import { buildConversationReply, buildSystemPrompt, meterFor } from './conversation';
import { CoverageMeter, type KnownWord } from './reading-challenge';

const ru = getLanguageConfig('ru');
const KNOWN: KnownWord[] = [
  { word: 'кот', state: 'level2' },
  { word: 'дом', state: 'known' },
  { word: 'привет', state: 'known' },
  { word: 'как', state: 'known' },
  { word: 'дела', state: 'known' },
];
const classify = (words: readonly string[]) =>
  new Map<string, WordClass>(words.map((w) => [w, { key: w, lemmas: [], grammar: w === 'у' }]));
const meter = () => new CoverageMeter(KNOWN, ru, classify);

function fakeProvider(...replies: unknown[]) {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  const provider = {
    name: 'fake',
    async complete(options: { messages: Array<{ role: string; content: string }> }) {
      calls.push(options.messages);
      return JSON.stringify(replies[Math.min(calls.length - 1, replies.length - 1)]);
    },
  } as unknown as LLMProvider;
  return { provider, calls };
}

describe('buildSystemPrompt', () => {
  const base = { languageName: 'Russian', allowed: ['кот'], focus: ['кот'], topic: '' };

  test('states the language, the vocabulary and the share of new words', () => {
    const prompt = buildSystemPrompt({ ...base, newPercent: 3 });
    expect(prompt).toContain('Talk only in Russian');
    expect(prompt).toContain('At most 3% of the words');
    expect(prompt).toContain('кот');
  });

  test('forbids new words at 0% and carries a topic', () => {
    const prompt = buildSystemPrompt({ ...base, newPercent: 0, topic: 'cats' });
    expect(prompt).toContain('Use no words outside that vocabulary.');
    expect(prompt).toContain('The conversation is about: cats.');
  });

  test('falls back to simple words for a learner with no vocabulary', () => {
    const prompt = buildSystemPrompt({ ...base, allowed: [], focus: [], newPercent: 3 });
    expect(prompt).toContain('The learner is a beginner');
  });
});

describe('buildConversationReply', () => {
  test('opens the conversation and measures the reply', async () => {
    const { provider, calls } = fakeProvider({
      reply: 'Привет! Как дела?',
      translation: 'Hi! How are you?',
    });
    const reply = await buildConversationReply(
      provider,
      { history: [], known: KNOWN, pack: ru, newPercent: 3, topic: '' },
      meter(),
    );
    expect(reply).toMatchObject({
      reply: 'Привет! Как дела?',
      translation: 'Hi! How are you?',
      newPercent: 0,
      newWords: [],
    });
    expect(calls[0][0].role).toBe('system');
    expect(calls[0][1]).toEqual({
      role: 'user',
      content: '(The learner has joined. Start the conversation.)',
    });
  });

  test('passes the history in order', async () => {
    const { provider, calls } = fakeProvider({ reply: 'Кот дома?', translation: '' });
    await buildConversationReply(
      provider,
      {
        history: [
          { role: 'user', text: 'Привет' },
          { role: 'assistant', text: 'Привет! Как дела?' },
          { role: 'user', text: 'У меня кот' },
        ],
        known: KNOWN,
        pack: ru,
        newPercent: 3,
        topic: '',
      },
      meter(),
    );
    expect(calls[0].slice(1)).toEqual([
      { role: 'user', content: 'Привет' },
      { role: 'assistant', content: 'Привет! Как дела?' },
      { role: 'user', content: 'У меня кот' },
    ]);
  });

  test('rewrites a reply with too many new words and keeps the better one', async () => {
    const { provider, calls } = fakeProvider(
      { reply: 'Слон жираф кот.', translation: 'Elephant giraffe cat.' },
      { reply: 'Кот дом.', translation: 'Cat house.' },
    );
    const reply = await buildConversationReply(
      provider,
      { history: [{ role: 'user', text: 'Привет' }], known: KNOWN, pack: ru, newPercent: 3, topic: '' },
      meter(),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1][0].content).toContain('слон, жираф');
    expect(reply).toMatchObject({ reply: 'Кот дом.', newPercent: 0 });
  });

  test('returns null when the model sends no reply', async () => {
    const { provider } = fakeProvider({ translation: 'x' });
    expect(
      await buildConversationReply(
        provider,
        { history: [], known: KNOWN, pack: ru, newPercent: 3, topic: '' },
        meter(),
      ),
    ).toBeNull();
  });
});

describe('meterFor', () => {
  test('reuses a meter until the word count changes or it expires', () => {
    const a = meterFor('u\0ru', KNOWN, ru, 1000);
    expect(meterFor('u\0ru', KNOWN, ru, 2000)).toBe(a);
    expect(meterFor('u\0ru', KNOWN.slice(1), ru, 3000)).not.toBe(a);
    const b = meterFor('u\0ru', KNOWN.slice(1), ru, 3000);
    expect(meterFor('u\0ru', KNOWN.slice(1), ru, 3000 + 11 * 60 * 1000)).not.toBe(b);
  });
});
