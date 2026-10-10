import type { WordState } from '../db';
import { classifyWords, type WordClass } from './dictionary-db';
import { buildSegmentWords } from './html-to-markdown';
import {
  foldWord,
  makeWordSegmentation,
  parseStoredSegmentWords,
  tokenizeWords,
  type LanguageConfig,
} from './languages';
import { completeJson, type LLMProvider } from './llm';

export const RECALL_DEFAULT_COUNT = 10;
export const RECALL_MAX_COUNT = 30;
export const RECALL_MIN_VOCAB = 5;
const FOCUS_WORD_LIMIT = 60;
const ALLOWED_WORD_LIMIT = 800;
const EXTRA_SENTENCES = 5;

export interface RecallVocab {
  id: string;
  text: string;
  state: WordState;
}

export interface RecallWord {
  id: string;
  text: string;
}

export interface RecallCandidate {
  english: string;
  reference: string;
}

export interface RecallNote {
  original: string;
  corrected: string;
  explanation: string;
}

export interface RecallGrade {
  correct: boolean;
  corrected: string;
  notes: RecallNote[];
  /** Practised words the answer left out or got wrong, as vocab texts. */
  missed: string[];
}

export interface VocabChange {
  id: string;
  text: string;
  from: WordState;
  to: WordState;
}

const LEVEL_UP: Record<WordState, WordState> = {
  new: 'level1',
  level1: 'level2',
  level2: 'level3',
  level3: 'level4',
  level4: 'known',
  known: 'known',
  ignored: 'ignored',
};

const LEVEL_DOWN: Record<WordState, WordState> = {
  new: 'new',
  level1: 'level1',
  level2: 'level1',
  level3: 'level2',
  level4: 'level3',
  known: 'level4',
  ignored: 'ignored',
};

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The words today's sentences should practise: two learning words for every known one. */
export function selectFocusWords(
  vocab: readonly RecallVocab[],
  random: () => number = Math.random,
): RecallVocab[] {
  const learning = shuffle(
    vocab.filter((v) => v.state !== 'known'),
    random,
  );
  const known = shuffle(
    vocab.filter((v) => v.state === 'known'),
    random,
  );
  const out: RecallVocab[] = [];
  while (out.length < FOCUS_WORD_LIMIT && (learning.length > 0 || known.length > 0)) {
    for (const pool of [learning, learning, known]) {
      const next = pool.shift();
      if (next && out.length < FOCUS_WORD_LIMIT) out.push(next);
    }
  }
  return out;
}

export function buildGenerationPrompt(opts: {
  languageName: string;
  allowed: readonly string[];
  focus: readonly string[];
  count: number;
  avoid: readonly string[];
}): string {
  const avoid =
    opts.avoid.length > 0
      ? `\nDo not reuse these English sentences from earlier days:\n${opts.avoid.map((s) => `- ${s}`).join('\n')}\n`
      : '';
  return `You write translation exercises for an English speaker learning ${opts.languageName}.

Write ${opts.count} short, natural English sentences (4 to 10 words each). For each one, also give a natural ${opts.languageName} translation.

Every ${opts.languageName} translation must use ONLY:
- words from the student's vocabulary list below, in any inflected form, and
- very common grammar words: pronouns, prepositions, conjunctions, particles, numbers, and the verb "to be".

Each sentence must practise at least one word from the focus list, ideally two or three. Vary tense, person and sentence type (statements, questions, negatives). Make each sentence self-contained and unambiguous, so it has one clear meaning.

Vocabulary list:
${opts.allowed.join(', ')}

Focus list:
${opts.focus.join(', ')}
${avoid}
Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
{"sentences": [{"english": "the English sentence", "translation": "the ${opts.languageName} translation"}]}`;
}

export async function generateRecallCandidates(
  provider: LLMProvider,
  opts: Parameters<typeof buildGenerationPrompt>[0],
): Promise<RecallCandidate[]> {
  const result = await completeJson<{ sentences?: unknown }>(provider, {
    messages: [{ role: 'user', content: buildGenerationPrompt(opts) }],
    maxTokens: 4096,
  });
  if (!Array.isArray(result.sentences)) return [];
  return result.sentences.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { english, translation } = item as Record<string, unknown>;
    if (typeof english !== 'string' || typeof translation !== 'string') return [];
    if (!english.trim() || !translation.trim()) return [];
    return [{ english: english.trim(), reference: translation.trim() }];
  });
}

function sentenceWords(text: string, pack: LanguageConfig): string[] {
  const segmentation = makeWordSegmentation(parseStoredSegmentWords(buildSegmentWords(text, pack)));
  return tokenizeWords(text, pack, segmentation).map((t) => foldWord(t.text, pack));
}

/**
 * Checks reference translations against the learner's vocab. A word is known
 * when it, or a lemma it inflects from, matches a vocab word or one of its lemmas.
 */
export class VocabMatcher {
  private readonly byKey = new Map<string, RecallVocab>();
  private readonly byLemma = new Map<string, RecallVocab>();

  constructor(
    vocab: readonly RecallVocab[],
    private readonly pack: LanguageConfig,
    private readonly classify: (words: readonly string[]) => Map<string, WordClass> | null,
  ) {
    const classes = classify(vocab.map((v) => v.text));
    for (const v of vocab) {
      const cls = classes?.get(v.text);
      this.byKey.set(cls?.key ?? v.text, v);
      for (const lemma of cls?.lemmas ?? []) {
        if (!this.byLemma.has(lemma)) this.byLemma.set(lemma, v);
      }
    }
  }

  static forLanguage(vocab: readonly RecallVocab[], pack: LanguageConfig): VocabMatcher {
    return new VocabMatcher(vocab, pack, (words) => classifyWords(words, pack.code));
  }

  /** Vocab words the sentence uses, and words that are neither vocab nor grammar. */
  analyse(sentence: string): { used: RecallVocab[]; unknown: string[] } {
    const words = sentenceWords(sentence, this.pack);
    const classes = this.classify(words);
    const used = new Map<string, RecallVocab>();
    const unknown: string[] = [];
    for (const word of words) {
      const cls = classes?.get(word);
      const key = cls?.key ?? word;
      const match =
        this.byKey.get(key) ??
        this.byLemma.get(key) ??
        cls?.lemmas.map((l) => this.byKey.get(l) ?? this.byLemma.get(l)).find(Boolean);
      if (match) used.set(match.id, match);
      else if (!cls?.grammar && classes !== null) unknown.push(word);
    }
    return { used: [...used.values()], unknown };
  }
}

export interface RecallSentence extends RecallCandidate {
  words: RecallWord[];
}

/**
 * Keep candidates that use only vocab and grammar words and practise at least
 * one vocab word. Candidates with one unknown word fill any shortfall.
 */
export function pickSentences(
  candidates: readonly RecallCandidate[],
  matcher: VocabMatcher,
  count: number,
): RecallSentence[] {
  const seen = new Set<string>();
  const scored = candidates.flatMap((candidate) => {
    const key = candidate.english.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const { used, unknown } = matcher.analyse(candidate.reference);
    if (used.length === 0 || unknown.length > 1) return [];
    const words = used.map((v) => ({ id: v.id, text: v.text }));
    return [{ sentence: { ...candidate, words }, unknown: unknown.length }];
  });
  return [...scored.filter((s) => s.unknown === 0), ...scored.filter((s) => s.unknown === 1)]
    .slice(0, count)
    .map((s) => s.sentence);
}

/** Generate and check today's sentences. Asks for spares, since some fail the check. */
export async function buildRecallSentences(
  provider: LLMProvider,
  opts: {
    vocab: readonly RecallVocab[];
    pack: LanguageConfig;
    count: number;
    avoid: readonly string[];
    random?: () => number;
  },
  matcher: VocabMatcher = VocabMatcher.forLanguage(opts.vocab, opts.pack),
): Promise<RecallSentence[]> {
  const focus = selectFocusWords(opts.vocab, opts.random);
  const allowed = shuffle([...opts.vocab], opts.random ?? Math.random)
    .slice(0, ALLOWED_WORD_LIMIT)
    .map((v) => v.text);
  const candidates = await generateRecallCandidates(provider, {
    languageName: opts.pack.name,
    allowed,
    focus: focus.map((v) => v.text),
    count: opts.count + EXTRA_SENTENCES,
    avoid: opts.avoid,
  });
  return pickSentences(candidates, matcher, opts.count);
}

export function buildGradingPrompt(opts: {
  languageName: string;
  english: string;
  reference: string;
  answer: string;
  words: readonly string[];
}): string {
  return `You are a ${opts.languageName} tutor grading a translation exercise. The student is an English speaker.

English sentence:
${opts.english}

One correct ${opts.languageName} translation:
${opts.reference}

The student's ${opts.languageName} translation:
${opts.answer}

Vocabulary the exercise practises: ${opts.words.join(', ')}

Mark the answer correct when it is grammatical ${opts.languageName} and means the same as the English sentence. Accept any natural wording, word order or synonym; it does not need to match the reference. Ignore capitalisation, punctuation and stress marks. A single small spelling slip that leaves the word recognisable is still correct, but note it. Wrong case, agreement, tense, aspect or a wrong or missing word makes it incorrect.

"corrected" is the student's answer with the fewest changes that make it correct. When the answer is already correct, repeat it unchanged.
"notes" lists each change, with a short English explanation.
"missed" lists the practised vocabulary words (as written in the list above) that the answer leaves out or uses incorrectly.

Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
{"correct": true, "corrected": "...", "notes": [{"original": "...", "corrected": "...", "explanation": "..."}], "missed": []}`;
}

export async function gradeRecallAnswer(
  provider: LLMProvider,
  opts: Parameters<typeof buildGradingPrompt>[0],
): Promise<RecallGrade> {
  const result = await completeJson<Record<string, unknown>>(provider, {
    messages: [{ role: 'user', content: buildGradingPrompt(opts) }],
    maxTokens: 1024,
  });
  const notes = Array.isArray(result.notes)
    ? result.notes.flatMap((n) => {
        if (!n || typeof n !== 'object') return [];
        const { original, corrected, explanation } = n as Record<string, unknown>;
        return typeof original === 'string' &&
          typeof corrected === 'string' &&
          typeof explanation === 'string'
          ? [{ original, corrected, explanation }]
          : [];
      })
    : [];
  return {
    correct: result.correct === true,
    corrected: typeof result.corrected === 'string' ? result.corrected : opts.answer,
    notes,
    missed: Array.isArray(result.missed)
      ? result.missed.filter((w): w is string => typeof w === 'string')
      : [],
  };
}

/**
 * The level moves for a verdict. A correct answer raises every practised word;
 * an incorrect one lowers the missed words, or all of them when none are named.
 */
export function vocabChangesFor(
  correct: boolean,
  practised: readonly RecallVocab[],
  missed: readonly string[],
  pack: LanguageConfig,
): VocabChange[] {
  const missedKeys = new Set(missed.map((w) => foldWord(w, pack)));
  const named = practised.filter((v) => missedKeys.has(foldWord(v.text, pack)));
  const targets = correct ? practised : named.length > 0 ? named : practised;
  return targets.flatMap((v) => {
    const to = correct ? LEVEL_UP[v.state] : LEVEL_DOWN[v.state];
    return to === v.state ? [] : [{ id: v.id, text: v.text, from: v.state, to }];
  });
}
