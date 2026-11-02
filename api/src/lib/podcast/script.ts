import type { WordState } from '../../db';
import { classifyWords, type ExpandedDictionaryEntry, type WordClass } from '../dictionary-db';
import { foldWord, type LanguageConfig } from '../languages';
import { completeJson, type LLMProvider } from '../llm';
import type { KnownWord } from '../reading-challenge';
import { sentenceWords, VocabMatcher } from '../recall';
import type { PODCAST_EXPLAIN_LEVELS } from '../settings-keys';

export type ExplainBelow = (typeof PODCAST_EXPLAIN_LEVELS)[number];
export const DEFAULT_EXPLAIN_BELOW: ExplainBelow = 'level3';

const MAX_WORDS_PER_SENTENCE = 12;
const MAX_NOTES_PER_SENTENCE = 8;
const MAX_NOTE_CHARS = 600;
const MAX_FACT_CHARS = 300;

const STATE_RANK: Record<WordState, number> = {
  new: 0,
  level1: 1,
  level2: 2,
  level3: 3,
  level4: 4,
  known: 5,
  ignored: 6,
};

/** The words the narrator treats as known. Ignored words always count as known. */
export function knownForPodcast(
  known: readonly KnownWord[],
  explainBelow: ExplainBelow,
): KnownWord[] {
  const min = STATE_RANK[explainBelow];
  return known.filter((k) => STATE_RANK[k.state] >= min);
}

type Classify = (words: readonly string[]) => Map<string, WordClass> | null;

/**
 * Finds the words of a sentence the learner does not know. Inflected forms of
 * known words and grammar words count as known when the language has a dictionary.
 */
export class UnknownWordFinder {
  private readonly matcher: VocabMatcher | null;
  private readonly keys: Set<string>;

  constructor(
    known: readonly KnownWord[],
    private readonly pack: LanguageConfig,
    classify: Classify = (words) => classifyWords(words, pack.code),
  ) {
    this.keys = new Set(known.map((k) => foldWord(k.word, pack)));
    this.matcher =
      classify([]) !== null
        ? new VocabMatcher(
            known.map((k) => ({ id: k.word, text: k.word, state: k.state })),
            pack,
            classify,
          )
        : null;
  }

  /** Distinct folded words, in sentence order. */
  find(sentence: string): string[] {
    const unknown = this.matcher
      ? this.matcher.analyse(sentence).unknown
      : sentenceWords(sentence, this.pack).filter((w) => !this.keys.has(w));
    return [...new Set(unknown)].filter((w) => /\p{L}/u.test(w));
  }
}

/** Dictionary facts for the prompt, or null when the dictionary has no entry. */
export function describeEntry(entry: ExpandedDictionaryEntry | undefined): string | null {
  if (!entry) return null;
  const parts: string[] = [];
  if (entry.lemmaInfo) parts.push(`${entry.lemmaInfo.label} ${entry.lemmaInfo.stem}`.trim());
  const glosses = entry.senses.map((s) => s.gloss.trim()).filter(Boolean);
  if (glosses.length > 0) parts.push(glosses.slice(0, 3).join('; '));
  for (const lemma of entry.lemmaEntries ?? []) {
    const lemmaGlosses = lemma.senses.map((s) => s.gloss.trim()).filter(Boolean);
    if (lemmaGlosses.length > 0)
      parts.push(`${lemma.word}: ${lemmaGlosses.slice(0, 2).join('; ')}`);
  }
  const text = parts.join(' — ');
  return text ? text.slice(0, MAX_FACT_CHARS) : null;
}

export interface WordToExplain {
  word: string;
  facts: string | null;
}

export interface SentencePlan {
  text: string;
  words: WordToExplain[];
}

/**
 * The words each sentence explains. A word is explained once per episode, at
 * its first sentence; `alreadyExplained` holds the words earlier paragraphs covered.
 */
export function planSentences(
  sentences: readonly string[],
  finder: UnknownWordFinder,
  alreadyExplained: ReadonlySet<string>,
  describe: (word: string) => string | null,
): SentencePlan[] {
  const seen = new Set(alreadyExplained);
  return sentences.map((text) => {
    const words = finder
      .find(text)
      .filter((word) => !seen.has(word))
      .slice(0, MAX_WORDS_PER_SENTENCE);
    for (const word of words) seen.add(word);
    return { text, words: words.map((word) => ({ word, facts: describe(word) })) };
  });
}

export function buildScriptPrompt(opts: {
  languageName: string;
  sentences: readonly SentencePlan[];
  previous: string | null;
}): string {
  const lang = opts.languageName;
  const sentences = opts.sentences
    .map((s, i) => {
      const words =
        s.words.length === 0
          ? '   Words to explain: none'
          : `   Words to explain:\n${s.words
              .map((w) => `   - ${w.word}${w.facts ? ` (dictionary: ${w.facts})` : ''}`)
              .join('\n')}`;
      return `${i + 1}. ${s.text}\n${words}`;
    })
    .join('\n');
  const previous = opts.previous
    ? `\nThe paragraph before this one, for context only:\n${opts.previous}\n`
    : '';
  return `You host a slow-reading podcast for an English speaker who is learning ${lang}. The text is read one sentence at a time. After each sentence, you explain it in English.

For each sentence, write short spoken notes in this order:
1. One note for each word in "Words to explain": what it means in this sentence, and its dictionary form when the sentence uses an inflected form. Use the dictionary facts when they are given, and do not contradict them.
2. Then at most two notes about grammar, idioms or figures of speech in the sentence that a learner needs explained, such as cases, verb aspect, word order, set phrases or metaphors. Skip this when there is nothing worth saying.

A sentence with no words to explain and nothing notable gets no notes.

Each note is natural spoken English, one to three sentences long. Wrap every ${lang} word or phrase in «guillemets», and never put English inside them. Do not repeat or translate the whole sentence.
${previous}
Sentences:
${sentences}

Respond with ONLY a JSON object in this exact format (no markdown, no code blocks). "n" is the sentence number. "kind" is "word", "phrase", "grammar" or "idiom".
{"sentences": [{"n": 1, "notes": [{"kind": "word", "say": "..."}]}]}`;
}

export type NoteKind = 'word' | 'phrase' | 'grammar' | 'idiom';

export interface ScriptNote {
  kind: NoteKind;
  say: string;
}

const NOTE_KINDS = new Set<string>(['word', 'phrase', 'grammar', 'idiom']);

function clampNote(say: string): string {
  if (say.length <= MAX_NOTE_CHARS) return say;
  const cut = say.slice(0, MAX_NOTE_CHARS);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 0)).trim() || cut;
}

/** The model's notes per sentence, word notes first. Malformed items are dropped. */
export function parseScriptNotes(raw: unknown, sentenceCount: number): ScriptNote[][] {
  const out: ScriptNote[][] = Array.from({ length: sentenceCount }, () => []);
  const items =
    raw && typeof raw === 'object' && Array.isArray((raw as { sentences?: unknown }).sentences)
      ? ((raw as { sentences: unknown[] }).sentences as unknown[])
      : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const { n, notes } = item as { n?: unknown; notes?: unknown };
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > sentenceCount) continue;
    if (!Array.isArray(notes)) continue;
    for (const note of notes) {
      if (out[n - 1].length >= MAX_NOTES_PER_SENTENCE) break;
      if (!note || typeof note !== 'object') continue;
      const { kind, say } = note as { kind?: unknown; say?: unknown };
      if (typeof say !== 'string') continue;
      const text = say.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out[n - 1].push({
        kind: typeof kind === 'string' && NOTE_KINDS.has(kind) ? (kind as NoteKind) : 'grammar',
        say: clampNote(text),
      });
    }
  }
  const isWordNote = (note: ScriptNote) => note.kind === 'word' || note.kind === 'phrase';
  return out.map((notes) => [...notes.filter(isWordNote), ...notes.filter((n) => !isWordNote(n))]);
}

export async function writeParagraphNotes(
  provider: LLMProvider,
  opts: { languageName: string; sentences: readonly SentencePlan[]; previous: string | null },
): Promise<ScriptNote[][]> {
  const raw = await completeJson<unknown>(provider, {
    messages: [{ role: 'user', content: buildScriptPrompt(opts) }],
    maxTokens: 6000,
    task: 'podcast-script',
  });
  return parseScriptNotes(raw, opts.sentences.length);
}

/** `slow` and `read` lines are target-language text; every other kind is English narration. */
export type LineKind = 'intro' | 'heading' | 'slow' | 'note' | 'read' | 'outro';

export interface ScriptLine {
  kind: LineKind;
  text: string;
}

export function isTargetLine(line: ScriptLine): boolean {
  return line.kind === 'slow' || line.kind === 'read';
}

const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/** Wrap a title in «» when the target voice should say it. */
function spokenTitle(title: string, pack: LanguageConfig): string {
  const latinPack = LATIN_LETTER.test(pack.testPhrase);
  return NON_LATIN_LETTER.test(title) || latinPack ? `«${title}»` : title;
}

export function episodeIntro(opts: {
  pack: LanguageConfig;
  sourceTitle: string;
  bookTitle: string | null;
  paraFrom: number;
  paraTo: number;
  wholeChapter: boolean;
}): string {
  const book = opts.bookTitle ? `, from ${spokenTitle(opts.bookTitle, opts.pack)}` : '';
  const range = opts.wholeChapter ? '' : `, paragraphs ${opts.paraFrom} to ${opts.paraTo}`;
  return `Welcome. In this episode we read ${spokenTitle(opts.sourceTitle, opts.pack)}${book}${range}. I read each sentence slowly and explain it, and at the end of each paragraph you hear the whole paragraph again.`;
}

export const EPISODE_OUTRO = 'That is the end of this episode. Thank you for listening.';

/**
 * The spoken lines of one paragraph. The source sentences are read exactly as
 * written; the model only supplies the notes between them.
 */
export function assembleParagraph(opts: {
  number: number;
  sentences: readonly string[];
  notes: readonly ScriptNote[][];
  intro?: string;
  outro?: string;
}): ScriptLine[] {
  const lines: ScriptLine[] = [];
  if (opts.intro) lines.push({ kind: 'intro', text: opts.intro });
  lines.push({ kind: 'heading', text: `Paragraph ${opts.number}.` });
  opts.sentences.forEach((sentence, i) => {
    lines.push({ kind: 'slow', text: sentence });
    for (const note of opts.notes[i] ?? []) lines.push({ kind: 'note', text: note.say });
  });
  if (opts.sentences.length > 1) {
    lines.push({ kind: 'heading', text: 'Now the whole paragraph.' });
    for (const sentence of opts.sentences) lines.push({ kind: 'read', text: sentence });
  }
  if (opts.outro) lines.push({ kind: 'outro', text: opts.outro });
  return lines;
}
