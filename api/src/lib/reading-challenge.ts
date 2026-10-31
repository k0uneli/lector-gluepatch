import type { WordState } from '../db';
import { classifyWords, type WordClass } from './dictionary-db';
import { foldWord, type LanguageConfig } from './languages';
import { completeJson, type LLMProvider } from './llm';
import { sentenceWords, VocabMatcher, type RecallVocab } from './recall';

export const READING_DEFAULT_WORDS = 200;
export const READING_MIN_WORDS = 100;
export const READING_MAX_WORDS = 600;
export const READING_DEFAULT_NEW_PERCENT = 5;
export const READING_MAX_NEW_PERCENT = 20;
export const READING_MIN_KNOWN = 30;
const ALLOWED_WORD_LIMIT = 800;
const FOCUS_WORD_LIMIT = 25;
/** Percentage points over target that trigger one revision. */
const REVISION_SLACK = 3;
const NEW_WORDS_IN_PROMPT = 60;

export interface KnownWord {
  word: string;
  state: WordState;
}

export interface ReadingText {
  title: string;
  text: string;
}

export interface ReadingCoverage {
  totalWords: number;
  /** Distinct folded words outside the learner's vocabulary. */
  newWords: string[];
  newPercent: number;
}

export interface ReadingChallengeText extends ReadingText, ReadingCoverage {}

type Classify = (words: readonly string[]) => Map<string, WordClass> | null;

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const isLearning = (state: WordState) => state.startsWith('level');

/**
 * Measures how much of a text falls outside the learner's words. Inflected
 * forms and grammar words count as known when the language has a dictionary.
 */
export class CoverageMeter {
  private readonly matcher: VocabMatcher | null;
  private readonly keys: Set<string>;

  constructor(
    known: readonly KnownWord[],
    private readonly pack: LanguageConfig,
    classify: Classify = (words) => classifyWords(words, pack.code),
  ) {
    const counted = known.filter((k) => k.state !== 'new');
    this.keys = new Set(counted.map((k) => foldWord(k.word, pack)));
    const hasDictionary = classify([]) !== null;
    this.matcher = hasDictionary
      ? new VocabMatcher(
          counted.map((k): RecallVocab => ({ id: k.word, text: k.word, state: k.state })),
          pack,
          classify,
        )
      : null;
  }

  measure(text: string): ReadingCoverage {
    const words = sentenceWords(text, this.pack);
    if (words.length === 0) return { totalWords: 0, newWords: [], newPercent: 0 };
    const unknown = this.matcher
      ? this.matcher.analyse(text).unknown
      : words.filter((w) => !this.keys.has(w));
    return {
      totalWords: words.length,
      newWords: [...new Set(unknown)],
      newPercent: Math.round((1000 * unknown.length) / words.length) / 10,
    };
  }
}

export function buildReadingPrompt(opts: {
  languageName: string;
  words: number;
  newPercent: number;
  allowed: readonly string[];
  focus: readonly string[];
  avoidTitles: readonly string[];
}): string {
  const newCount = Math.round((opts.words * opts.newPercent) / 100);
  const newRule =
    newCount === 0
      ? 'Use no other words.'
      : `About ${opts.newPercent}% of the words (roughly ${newCount} of ${opts.words}) may be words outside the list. Choose them from common, useful vocabulary, and use each in a context that makes its meaning guessable. Every other word must come from the list or the grammar words.`;
  const focus =
    opts.focus.length > 0
      ? `\nThe learner is practising these words. Use as many as fit naturally:\n${opts.focus.join(', ')}\n`
      : '';
  const avoid =
    opts.avoidTitles.length > 0
      ? `\nDo not reuse the topics of these earlier texts:\n${opts.avoidTitles.map((t) => `- ${t}`).join('\n')}\n`
      : '';
  return `You write graded reading texts for an English speaker learning ${opts.languageName}.

Write one ${opts.languageName} text of about ${opts.words} words: a short story, a diary entry, a dialogue or a short article. Make it interesting to read, with a clear thread from start to end. Give it a short ${opts.languageName} title.

The learner knows the words in the vocabulary list below, in any inflected form, and common grammar words: pronouns, prepositions, conjunctions, particles, numbers and the verb "to be". ${newRule}
${focus}
Vocabulary list:
${opts.allowed.join(', ')}
${avoid}
Respond with ONLY a JSON object in this exact format (no markdown, no code blocks). Separate paragraphs in "text" with a blank line.
{"title": "the title", "text": "the text"}`;
}

export function buildRevisionPrompt(opts: {
  languageName: string;
  draft: ReadingText;
  coverage: ReadingCoverage;
  targetPercent: number;
  allowed: readonly string[];
}): string {
  return `You are revising a graded ${opts.languageName} reading text for an English speaker.

${opts.coverage.newPercent}% of its words are outside the learner's vocabulary. The target is at most ${opts.targetPercent}%. Replace most of these words with words from the vocabulary list below, in any inflected form, or with common grammar words. Keep the story, the length and the title.

Words to replace:
${opts.coverage.newWords.slice(0, NEW_WORDS_IN_PROMPT).join(', ')}

Vocabulary list:
${opts.allowed.join(', ')}

Text:
${JSON.stringify(opts.draft)}

Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
{"title": "the title", "text": "the revised text"}`;
}

async function requestText(provider: LLMProvider, prompt: string): Promise<ReadingText | null> {
  const result = await completeJson<{ title?: unknown; text?: unknown }>(provider, {
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4096,
  });
  const title = typeof result.title === 'string' ? result.title.trim() : '';
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  return text ? { title, text } : null;
}

/** The prompt's word lists: learning words first, then a sample of the rest. */
export function selectWords(
  known: readonly KnownWord[],
  random: () => number = Math.random,
): { allowed: string[]; focus: string[] } {
  const usable = known.filter((k) => k.state !== 'new' && k.state !== 'ignored');
  const learning = shuffle(
    usable.filter((k) => isLearning(k.state)),
    random,
  ).map((k) => k.word);
  const rest = shuffle(
    usable.filter((k) => !isLearning(k.state)),
    random,
  ).map((k) => k.word);
  return {
    allowed: [...learning, ...rest].slice(0, ALLOWED_WORD_LIMIT),
    focus: learning.slice(0, FOCUS_WORD_LIMIT),
  };
}

/** Write today's text and measure it. Revises once when it has too many new words. */
export async function buildReadingChallenge(
  provider: LLMProvider,
  opts: {
    known: readonly KnownWord[];
    pack: LanguageConfig;
    words: number;
    newPercent: number;
    avoidTitles: readonly string[];
    random?: () => number;
  },
  meter: CoverageMeter = new CoverageMeter(opts.known, opts.pack),
): Promise<ReadingChallengeText | null> {
  const { allowed, focus } = selectWords(opts.known, opts.random);
  const draft = await requestText(
    provider,
    buildReadingPrompt({
      languageName: opts.pack.name,
      words: opts.words,
      newPercent: opts.newPercent,
      allowed,
      focus,
      avoidTitles: opts.avoidTitles,
    }),
  );
  if (!draft) return null;
  let best = { ...draft, ...meter.measure(draft.text) };
  if (best.newPercent <= opts.newPercent + REVISION_SLACK) return best;

  const revised = await requestText(
    provider,
    buildRevisionPrompt({
      languageName: opts.pack.name,
      draft,
      coverage: best,
      targetPercent: opts.newPercent,
      allowed,
    }),
  ).catch(() => null);
  if (revised) {
    const measured = { ...revised, title: revised.title || draft.title, ...meter.measure(revised.text) };
    if (measured.newPercent < best.newPercent) best = measured;
  }
  return best;
}
