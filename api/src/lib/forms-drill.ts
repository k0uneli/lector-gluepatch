import { db } from '../db';
import { getParadigm, headwordGloss } from './dictionary-db';
import {
  foldWord,
  formatInflectionTags,
  stripMarks,
  type LanguageConfig,
  type Paradigm,
  type ParadigmCell,
} from './languages';

export type FormsKind = 'noun' | 'verb';
export const FORMS_KINDS: readonly FormsKind[] = ['noun', 'verb'];
export const FORMS_DEFAULT_COUNT = 10;
export const FORMS_MAX_COUNT = 30;
/** Paradigm lookups one round may spend before it gives up on filling. */
const MAX_LOOKUPS = 400;
const BANK_WORD_LIMIT = 2000;

export interface FormsItem {
  lemma: string;
  gloss: string | null;
  kind: FormsKind;
  /** The cell to produce, e.g. ["genitive", "plural"]. */
  tags: string[];
  /** The cell in words, e.g. "genitive plural". */
  prompt: string;
  /** Every form the dictionary lists for the cell. */
  answers: string[];
  paradigm: Paradigm;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Cells worth asking for: listed, and not the headword itself. */
export function drillCells(paradigm: Paradigm, pack: LanguageConfig): ParadigmCell[] {
  const key = (w: string) => stripMarks(foldWord(w, pack));
  const lemma = key(paradigm.lemma);
  return paradigm.tables.flatMap((t) =>
    t.rows.flatMap((r) =>
      r.cells.filter((c) => c.forms.length > 0 && !c.forms.some((f) => key(f) === lemma)),
    ),
  );
}

export function pickItem(
  paradigm: Paradigm,
  gloss: string | null,
  pack: LanguageConfig,
  random: () => number,
): FormsItem | null {
  if (paradigm.kind === 'adjective') return null;
  const cells = drillCells(paradigm, pack);
  if (cells.length === 0) return null;
  const cell = cells[Math.floor(random() * cells.length)];
  return {
    lemma: paradigm.lemma,
    gloss,
    kind: paradigm.kind,
    tags: cell.tags,
    prompt: formatInflectionTags(cell.tags),
    answers: cell.forms,
    paradigm,
  };
}

/** The learner's marked words first, then the sentence bank's words by frequency. */
export function candidateWords(
  userId: string,
  language: string,
  random: () => number,
): string[] {
  const marked = db
    .prepare(
      `SELECT word FROM knownWords
        WHERE userId = ? AND language = ? AND state NOT IN ('new', 'ignored')`,
    )
    .all(userId, language) as Array<{ word: string }>;
  const bank = db
    .prepare(
      `SELECT clozeWord, MIN(wordRank) AS rank FROM clozeSentences
        WHERE userId = ? AND language = ? AND wordRank IS NOT NULL
        GROUP BY clozeWord ORDER BY rank LIMIT ?`,
    )
    .all(userId, language, BANK_WORD_LIMIT) as Array<{ clozeWord: string }>;
  return [
    ...shuffle(
      marked.map((r) => r.word),
      random,
    ),
    ...shuffle(
      bank.map((r) => r.clozeWord.replace(/[^\p{L}\p{M}'’-]+/gu, '')),
      random,
    ),
  ].filter(Boolean);
}

/** A round of `count` items, mixing the kinds evenly when several are asked for. */
export function buildFormsRound(opts: {
  words: readonly string[];
  kinds: readonly FormsKind[];
  count: number;
  pack: LanguageConfig;
  random?: () => number;
  resolve?: (word: string) => Paradigm | null;
  gloss?: (lemma: string, kind: FormsKind) => string | null;
}): FormsItem[] {
  const random = opts.random ?? Math.random;
  const resolve = opts.resolve ?? ((w: string) => getParadigm(w, opts.pack.code));
  const gloss = opts.gloss ?? ((l: string, k: FormsKind) => headwordGloss(l, opts.pack.code, k));
  const buckets = new Map<FormsKind, FormsItem[]>(opts.kinds.map((k) => [k, []]));
  const seen = new Set<string>();
  const seenWords = new Set<string>();
  let lookups = 0;

  for (const word of opts.words) {
    if ([...buckets.values()].every((b) => b.length >= opts.count)) break;
    if (lookups >= MAX_LOOKUPS) break;
    const folded = foldWord(word, opts.pack);
    if (seenWords.has(folded)) continue;
    seenWords.add(folded);
    lookups++;
    const paradigm = resolve(word);
    if (!paradigm || paradigm.kind === 'adjective' || seen.has(paradigm.lemma)) continue;
    const kind = paradigm.kind;
    const bucket = buckets.get(kind);
    if (!bucket || bucket.length >= opts.count || !paradigm.partsOfSpeech.includes(kind)) continue;
    seen.add(paradigm.lemma);
    const meaning = gloss(paradigm.lemma, kind);
    if (!meaning) continue;
    const item = pickItem(paradigm, meaning, opts.pack, random);
    if (item) bucket.push(item);
  }

  const lists = [...buckets.values()];
  const mixed: FormsItem[] = [];
  for (let i = 0; mixed.length < opts.count && lists.some((l) => i < l.length); i++) {
    for (const list of lists) if (i < list.length && mixed.length < opts.count) mixed.push(list[i]);
  }
  return shuffle(mixed, random);
}
