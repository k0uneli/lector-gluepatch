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
const MAX_TRANSLATION_CHARS = 4000;

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
1. One note for each word in "Words to explain": the word, then its English translation as it is used in this sentence. Give one translation. Add a second only when one English word cannot carry the meaning, as with a compound. You may name the grammatical form briefly, as in: «σπιτιού» means of the house; it is the genitive. Do not give the dictionary form. Use the dictionary facts to choose the meaning, and do not contradict them.
2. Then at most two notes about grammar, idioms or figures of speech in the sentence that a learner needs explained, such as cases, verb aspect, word order, set phrases or metaphors. Skip this when there is nothing worth saying.

A sentence with no words to explain and nothing notable gets no notes.

Each word note is short, for example: «σπίτι» means house. A grammar or idiom note is natural spoken English, one to three sentences long. Wrap every ${lang} word or phrase in «guillemets», and never put English inside them. Do not repeat or translate the whole sentence in a note.

Also write "translation": a natural English translation of the whole paragraph, to be read aloud after it. Use no guillemets in the translation.
${previous}
Sentences:
${sentences}

Respond with ONLY a JSON object in this exact format (no markdown, no code blocks). "n" is the sentence number. "kind" is "word", "phrase", "grammar" or "idiom".
{"translation": "...", "sentences": [{"n": 1, "notes": [{"kind": "word", "say": "..."}]}]}`;
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

/** The model's English translation of the paragraph, or null when it gave none. */
export function parseTranslation(raw: unknown): string | null {
  const value =
    raw && typeof raw === 'object' ? (raw as { translation?: unknown }).translation : undefined;
  if (typeof value !== 'string') return null;
  const text = value.replace(/[«»]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= MAX_TRANSLATION_CHARS) return text;
  const cut = text.slice(0, MAX_TRANSLATION_CHARS);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 0)).trim() || cut;
}

export interface ParagraphScript {
  notes: ScriptNote[][];
  translation: string | null;
}

export async function writeParagraphScript(
  provider: LLMProvider,
  opts: { languageName: string; sentences: readonly SentencePlan[]; previous: string | null },
): Promise<ParagraphScript> {
  const raw = await completeJson<unknown>(provider, {
    messages: [{ role: 'user', content: buildScriptPrompt(opts) }],
    maxTokens: 6000,
    task: 'podcast-script',
  });
  return {
    notes: parseScriptNotes(raw, opts.sentences.length),
    translation: parseTranslation(raw),
  };
}

/** `slow` and `read` lines are target-language text; every other kind is English narration. */
export type LineKind = 'intro' | 'heading' | 'slow' | 'note' | 'read' | 'translation' | 'outro';

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
  return `Welcome. In this episode we read ${spokenTitle(opts.sourceTitle, opts.pack)}${book}${range}. I read each sentence slowly and explain it. At the end of each paragraph you hear the whole paragraph again, then its English translation.`;
}

export const EPISODE_OUTRO = 'That is the end of this episode. Thank you for listening.';

/**
 * The spoken lines of one paragraph. The source sentences are read exactly as
 * written; the model only supplies the notes between them.
 */
export function assembleParagraph(opts: {
  number: number;
  /** A later chunk of the same paragraph. */
  continued?: boolean;
  sentences: readonly string[];
  notes: readonly ScriptNote[][];
  translation?: string | null;
  intro?: string;
  outro?: string;
}): ScriptLine[] {
  const lines: ScriptLine[] = [];
  if (opts.intro) lines.push({ kind: 'intro', text: opts.intro });
  lines.push({
    kind: 'heading',
    text: opts.continued ? `Paragraph ${opts.number}, continued.` : `Paragraph ${opts.number}.`,
  });
  opts.sentences.forEach((sentence, i) => {
    lines.push({ kind: 'slow', text: sentence });
    for (const note of opts.notes[i] ?? []) lines.push({ kind: 'note', text: note.say });
  });
  if (opts.sentences.length > 1) {
    lines.push({ kind: 'heading', text: 'Now the whole paragraph.' });
    for (const sentence of opts.sentences) lines.push({ kind: 'read', text: sentence });
  }
  if (opts.translation) {
    lines.push({ kind: 'heading', text: 'In English.' });
    lines.push({ kind: 'translation', text: opts.translation });
  }
  if (opts.outro) lines.push({ kind: 'outro', text: opts.outro });
  return lines;
}
