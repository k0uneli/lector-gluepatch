import type { ChatMessage } from './llm';
import { completeJson, type LLMProvider } from './llm';
import type { LanguageConfig } from './languages';
import {
  CoverageMeter,
  selectWords,
  type KnownWord,
  type ReadingCoverage,
} from './reading-challenge';

export const CONVERSATION_DEFAULT_NEW_PERCENT = 3;
export const CONVERSATION_MAX_NEW_PERCENT = 20;
export const CONVERSATION_MAX_TURNS = 40;
export const CONVERSATION_MAX_MESSAGE_LENGTH = 1000;
export const CONVERSATION_MAX_TOPIC_LENGTH = 200;
/** The prompt carries only the latest turns. */
const HISTORY_TURNS = 20;
/** Points over the target that trigger one rewrite. In a short reply one word is several points. */
const REVISION_SLACK = 5;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ConversationReply extends ReadingCoverage {
  reply: string;
  /** English translation of the reply. */
  translation: string;
}

export function buildSystemPrompt(opts: {
  languageName: string;
  newPercent: number;
  allowed: readonly string[];
  focus: readonly string[];
  topic: string;
}): string {
  const vocabulary =
    opts.allowed.length > 0
      ? `The learner knows these words, in any inflected form, and common grammar words (pronouns, prepositions, conjunctions, particles, numbers, the verb "to be"):\n${opts.allowed.join(', ')}`
      : 'The learner is a beginner. Use only the simplest, most common words.';
  const newRule =
    opts.newPercent === 0
      ? 'Use no words outside that vocabulary.'
      : `At most ${opts.newPercent}% of the words in each reply may be outside that vocabulary. Make any new word guessable from context.`;
  const focus =
    opts.focus.length > 0
      ? `\nWork in some of the words the learner is practising when they fit: ${opts.focus.join(', ')}.`
      : '';
  const topic = opts.topic ? `\nThe conversation is about: ${opts.topic}.` : '';
  return `You are a friendly conversation partner for an English speaker learning ${opts.languageName}. Talk only in ${opts.languageName}.

Keep each reply short: one to three sentences that sound natural when spoken. Usually end with a question so the conversation continues. When the learner makes a mistake, do not lecture; use the correct form naturally in your reply.

${vocabulary}

${newRule}${focus}${topic}

Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
{"reply": "your ${opts.languageName} reply", "translation": "its English translation"}`;
}

export function buildRevisionPrompt(opts: {
  languageName: string;
  reply: string;
  coverage: ReadingCoverage;
  targetPercent: number;
  allowed: readonly string[];
}): string {
  return `Rewrite this ${opts.languageName} reply so that at most ${opts.targetPercent}% of its words are outside the learner's vocabulary. Keep its meaning and keep it short.

Reply:
${opts.reply}

Replace these words with simpler ones from the vocabulary, or with common grammar words:
${opts.coverage.newWords.join(', ')}

Vocabulary:
${opts.allowed.join(', ')}

Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
{"reply": "the rewritten reply", "translation": "its English translation"}`;
}

function toChatMessages(history: readonly ConversationTurn[]): ChatMessage[] {
  const recent = history.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, content: t.text }));
  // The model expects the learner to speak first; an opening reply has no learner turn yet.
  return recent[0]?.role === 'user'
    ? recent
    : [{ role: 'user', content: '(The learner has joined. Start the conversation.)' }, ...recent];
}

async function requestReply(
  provider: LLMProvider,
  messages: ChatMessage[],
): Promise<{ reply: string; translation: string } | null> {
  const result = await completeJson<{ reply?: unknown; translation?: unknown }>(provider, {
    messages,
    maxTokens: 1024,
    task: 'chat',
  });
  const reply = typeof result.reply === 'string' ? result.reply.trim() : '';
  const translation = typeof result.translation === 'string' ? result.translation.trim() : '';
  return reply ? { reply, translation } : null;
}

/** The next partner turn, measured; rewritten once when it has too many new words. */
export async function buildConversationReply(
  provider: LLMProvider,
  opts: {
    history: readonly ConversationTurn[];
    known: readonly KnownWord[];
    pack: LanguageConfig;
    newPercent: number;
    topic: string;
    random?: () => number;
  },
  meter: CoverageMeter = new CoverageMeter(opts.known, opts.pack),
): Promise<ConversationReply | null> {
  const { allowed, focus } = selectWords(opts.known, opts.random);
  const system = buildSystemPrompt({
    languageName: opts.pack.name,
    newPercent: opts.newPercent,
    allowed,
    focus,
    topic: opts.topic,
  });
  const draft = await requestReply(provider, [
    { role: 'system', content: system },
    ...toChatMessages(opts.history),
  ]);
  if (!draft) return null;
  let best = { ...draft, ...meter.measure(draft.reply) };
  if (best.newPercent <= opts.newPercent + REVISION_SLACK || allowed.length === 0) return best;

  const revised = await requestReply(provider, [
    {
      role: 'user',
      content: buildRevisionPrompt({
        languageName: opts.pack.name,
        reply: draft.reply,
        coverage: best,
        targetPercent: opts.newPercent,
        allowed,
      }),
    },
  ]).catch(() => null);
  if (revised) {
    const measured = { ...revised, ...meter.measure(revised.reply) };
    if (measured.newPercent < best.newPercent) best = measured;
  }
  return best;
}

/** Meters reused across turns while the learner's word count is unchanged. */
const METER_TTL_MS = 10 * 60 * 1000;
const meters = new Map<string, { size: number; at: number; meter: CoverageMeter }>();

export function meterFor(
  key: string,
  known: readonly KnownWord[],
  pack: LanguageConfig,
  now = Date.now(),
): CoverageMeter {
  const cached = meters.get(key);
  if (cached && cached.size === known.length && now - cached.at < METER_TTL_MS) {
    return cached.meter;
  }
  for (const [k, entry] of meters) if (now - entry.at >= METER_TTL_MS) meters.delete(k);
  const meter = new CoverageMeter(known, pack);
  meters.set(key, { size: known.length, at: now, meter });
  return meter;
}

export interface TurnCorrection {
  /** The learner's turn with every fix applied. Equal to the turn when it is right. */
  corrected: string;
  corrections: Array<{ original: string; corrected: string; explanation: string; type: string }>;
  /** A longer English explanation of the mistakes, for the expanded view. */
  explanation: string;
}

export function buildCorrectionPrompt(opts: {
  languageName: string;
  text: string;
  previous: string | null;
  spoken: boolean;
}): string {
  const source = opts.spoken
    ? 'The turn is a speech-recognition transcript. Ignore punctuation and capital letters, and do not count a likely mis-hearing as the learner’s mistake; mention it in the explanation instead.'
    : 'The learner typed the turn.';
  const context = opts.previous
    ? `\nThe conversation partner had just said:\n${opts.previous}\n`
    : '';
  return `You are a ${opts.languageName} tutor. An English speaker learning ${opts.languageName} said this turn in a conversation. ${source}
${context}
Learner's turn:
${opts.text}

Find grammar mistakes (case, agreement, verb form, tense, aspect, word order), wrong or unnatural words, and missing or extra words. Do not rewrite a turn that is correct, and do not change its meaning or style.

"corrected" is the turn with the fewest changes that fix it. When it is already right, repeat it unchanged.
"corrections" lists each change: the exact original words, the corrected words, a one-sentence English explanation, and a type (grammar, spelling, word_choice, word_order, missing_word or extra_word).
"explanation" is a fuller English explanation for the learner: what each mistake was, the rule behind it, and a short example. Leave it empty when there are no mistakes.

Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
{"corrected": "...", "corrections": [{"original": "...", "corrected": "...", "explanation": "...", "type": "grammar"}], "explanation": "..."}`;
}

/** Null when the model's answer is unusable. */
export async function correctLearnerTurn(
  provider: LLMProvider,
  opts: Parameters<typeof buildCorrectionPrompt>[0],
): Promise<TurnCorrection | null> {
  const result = await completeJson<Record<string, unknown>>(provider, {
    messages: [{ role: 'user', content: buildCorrectionPrompt(opts) }],
    maxTokens: 2048,
  });
  if (typeof result.corrected !== 'string' || !result.corrected.trim()) return null;
  const corrections = Array.isArray(result.corrections)
    ? result.corrections.flatMap((c) => {
        const { original, corrected, explanation, type } = (c ?? {}) as Record<string, unknown>;
        return typeof original === 'string' && typeof corrected === 'string'
          ? [
              {
                original,
                corrected,
                explanation: typeof explanation === 'string' ? explanation : '',
                type: typeof type === 'string' ? type : 'grammar',
              },
            ]
          : [];
      })
    : [];
  return {
    corrected: result.corrected.trim(),
    corrections,
    explanation:
      corrections.length > 0 && typeof result.explanation === 'string'
        ? result.explanation.trim()
        : '',
  };
}
