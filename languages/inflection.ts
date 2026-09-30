// Rows come from the kaikki `inflections` table: (form, lemma, type), with
// `type` a comma-separated tag list such as `accusative,singular`.

import { graphemeSplit } from './graphemes';
import { foldForComparison, foldWord, lowerForPack, normalizeText, stripMarks } from './text';
import type { LanguageConfig } from './types';

export type ClozeDrill = 'word' | 'ending' | 'inflect';

export const CLOZE_DRILLS: readonly ClozeDrill[] = ['word', 'ending', 'inflect'];

export interface InflectionRow {
  form: string;
  type: string | null;
}

export interface SenseRow {
  pos: string | null;
  gloss: string;
}

/** What the API attaches to a card served for the Ending or Base form drill. */
export interface ClozeInflection {
  lemma: string;
  /** Imperfective then perfective infinitive, when the lemma has an aspect partner. */
  aspectPair: [string, string] | null;
  tags: string[];
  /** The form's grammar in words, e.g. "genitive singular or nominative/accusative plural". */
  description: string;
  /** Surface prefix and remainder of the answer; null when no ending matched. */
  stem: string | null;
  ending: string | null;
  distractors: string[];
}

// Single-tag types that relate two headwords, or respell one, instead of
// inflecting it: ru читать → прочитать is `perfective`, кот → котик `diminutive`.
const LINK_TYPES = new Set([
  'perfective',
  'imperfective',
  'active',
  'passive',
  'diminutive',
  'augmentative',
  'pejorative',
  'abstract-noun',
  'noun-from-verb',
  'adverb',
  'adjective',
  'demonym',
  'clipping',
  'collective',
  'alternative',
  'variant',
  'canonical',
  'ё-spelling',
  'unaccented',
  'headword',
  'form',
  'error-unrecognized-form',
  'unknown',
  'emphatic',
  'abbreviation',
]);

const STALE_TAGS = new Set([
  'dated',
  'obsolete',
  'archaic',
  'alternative',
  'idiomatic',
  'relational',
  'regional',
  'literary',
]);

// Tags that mark a variant spelling of one paradigm cell, not a different cell.
const VARIANT_TAGS = new Set(['rare', 'informal', 'colloquial']);

const DEGREE_TAGS = new Set(['comparative', 'superlative']);

const CASE_TAGS = new Set([
  'nominative',
  'genitive',
  'dative',
  'accusative',
  'instrumental',
  'prepositional',
  'locative',
  'vocative',
]);

const VERB_TAGS = new Set([
  'first-person',
  'second-person',
  'third-person',
  'present',
  'past',
  'future',
  'imperfect',
  'indicative',
  'imperative',
  'dependent',
  'participle',
]);

const GENDER_TAGS = new Set(['masculine', 'feminine', 'neuter']);

// A bare gender tag inflects these (el καλός → καλή). On a noun it names a
// different word (ru кот → кошка).
const AGREEING_POS = new Set(['adj', 'det', 'pron', 'num', 'article', 'participle']);

const UNINFLECTED_POS = new Set(['adv', 'particle', 'conj', 'prep', 'postp', 'intj']);

// kaikki form-of glosses: "genitive singular of кни́га (kníga)", or
// "inflection of кни́га (kníga):" followed by one sense per paradigm cell.
const FORM_OF_GLOSS = /^(.+?)\s+of\s+([^\s(:]+)/u;
const FORM_OF_TAIL = /\bof\s+[^\s(]+\s*[(:]/u;

const GRAMMAR_WORDS = new Set([
  'nominative',
  'genitive',
  'dative',
  'accusative',
  'instrumental',
  'prepositional',
  'locative',
  'vocative',
  'partitive',
  'singular',
  'plural',
  'masculine',
  'feminine',
  'neuter',
  'animate',
  'inanimate',
  'first-person',
  'second-person',
  'third-person',
  'present',
  'past',
  'future',
  'imperfect',
  'simple',
  'indicative',
  'imperative',
  'dependent',
  'active',
  'passive',
  'perfective',
  'imperfective',
  'participle',
  'adverbial',
  'short',
  'long',
  'and',
]);

export function parseTags(type: string | null): string[] {
  return type ? type.split(',').filter(Boolean) : [];
}

export function isInflectionType(type: string | null, lemmaPos: readonly string[]): boolean {
  const tags = parseTags(type);
  if (tags.length === 0) return false;
  if (tags.length === 1 && LINK_TYPES.has(tags[0])) return false;
  if (tags.some((tag) => STALE_TAGS.has(tag))) return false;
  if (tags.every((tag) => GENDER_TAGS.has(tag))) {
    return lemmaPos.some((pos) => AGREEING_POS.has(pos));
  }
  return true;
}

function isGrammarCell(gloss: string): boolean {
  return gloss.split(/[\s/]+/).every((word) => GRAMMAR_WORDS.has(word));
}

/**
 * True when the word is a headword in its own right that the lemma cannot
 * explain: ru так (adverb, not genitive of така), день (noun, not a form of деть).
 */
export function readsAsOwnWord(senses: readonly SenseRow[], lemmaPos: readonly string[]): boolean {
  return senses.some(
    ({ pos, gloss }) =>
      !!pos &&
      !FORM_OF_TAIL.test(gloss) &&
      !isGrammarCell(gloss) &&
      (UNINFLECTED_POS.has(pos) || !lemmaPos.includes(pos)),
  );
}

/** The form's grammar as the word's own form-of senses give it for `lemma`. */
export function describeForm(
  senses: readonly SenseRow[],
  lemma: string,
  pack: LanguageConfig,
): string | null {
  const lemmaKey = stripMarks(lowerForPack(lemma, pack));
  const cells: string[] = [];
  let collecting = false;
  for (const { gloss } of senses) {
    const match = gloss.match(FORM_OF_GLOSS);
    if (match) {
      const ofLemma = stripMarks(lowerForPack(match[2], pack)) === lemmaKey;
      collecting = ofLemma && match[1] === 'inflection';
      if (ofLemma && !collecting) cells.push(match[1]);
    } else if (collecting && isGrammarCell(gloss)) {
      cells.push(gloss);
    } else {
      collecting = false;
    }
  }
  if (cells.length === 0) return null;
  // kaikki's Modern Greek glosses call the aorist the simple past.
  return [...new Set(cells)].join(' or ').replace(/\bsimple past\b/g, 'aorist');
}

function comparisonKey(text: string, pack: LanguageConfig): string {
  return foldForComparison(foldWord(text, pack), pack);
}

/** True when `form` and `lemma` differ even after case and mark folding. */
export function isDistinctForm(form: string, lemma: string, pack: LanguageConfig): boolean {
  return comparisonKey(form, pack) !== comparisonKey(lemma, pack);
}

/**
 * Split `surface` where it shares a stem with the lemma and both remainders are
 * pack endings (дел+а beside дел+о); failing that, at the longest ending (мог+ла).
 */
export function splitEnding(
  surface: string,
  lemma: string,
  pack: LanguageConfig,
): { stem: string; ending: string } | null {
  if (!pack.inflection) return null;
  const { endings, lemmaEndings } = pack.inflection;

  const letters = graphemeSplit(normalizeText(surface));
  const key = graphemeSplit(comparisonKey(surface, pack));
  // The surface is sliced by the key's grapheme count, so the two must align.
  if (letters.length !== key.length) return null;
  const lemmaKey = graphemeSplit(comparisonKey(lemma, pack));
  const formEndings = new Set(endings.map((e) => comparisonKey(e, pack)));
  const citationEndings = new Set(lemmaEndings.map((e) => comparisonKey(e, pack)));

  const aligned = (k: number) =>
    key.slice(0, k).join('') === lemmaKey.slice(0, k).join('') &&
    (k === key.length || formEndings.has(key.slice(k).join(''))) &&
    (k === lemmaKey.length || citationEndings.has(lemmaKey.slice(k).join('')));

  let split = 0;
  for (let k = key.length - 1; k >= 2 && !split; k--) {
    if (aligned(k)) split = k;
  }
  // Aligned only with nothing left over is a zero ending (дел beside дел+о): nothing to fill in.
  if (!split && aligned(key.length)) return null;
  const insideLemma = key.every((letter, i) => letter === lemmaKey[i]);
  for (let k = 2; k < key.length && !split && !insideLemma; k++) {
    if (formEndings.has(key.slice(k).join(''))) split = k;
  }
  if (!split) return null;
  return { stem: letters.slice(0, split).join(''), ending: letters.slice(split).join('') };
}

/**
 * Russian keeps aspect partners as separate lemmas, linked by a single-tag
 * `perfective` or `imperfective` row in the lemma's paradigm.
 */
export function aspectPair(
  lemma: string,
  paradigm: readonly InflectionRow[],
): [string, string] | null {
  for (const row of paradigm) {
    if (row.type === 'perfective') return [lemma, row.form];
    if (row.type === 'imperfective') return [row.form, lemma];
  }
  return null;
}

const WORD_SHAPE = /^[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*$/u;
const ASCII_LETTER = /[A-Za-z]/;

function looseKey(form: string, pack: LanguageConfig): string {
  return comparisonKey(form, pack).replace(/ё/g, 'е');
}

function markCount(form: string): number {
  return (form.normalize('NFD').match(/\p{M}/gu) ?? []).length;
}

function tagKey(tags: readonly string[]): string {
  return tags
    .filter((tag) => !VARIANT_TAGS.has(tag))
    .sort()
    .join(',');
}

function wordKind(tags: readonly string[]): 'noun' | 'verb' | null {
  const nominal = tags.some((tag) => CASE_TAGS.has(tag));
  const verbal = tags.some((tag) => VERB_TAGS.has(tag));
  if (nominal === verbal) return null;
  return nominal ? 'noun' : 'verb';
}

export interface DistractorSource {
  answer: string;
  answerType: string | null;
  lemma: string;
  lemmaPos: readonly string[];
  paradigm: readonly InflectionRow[];
}

/**
 * Up to `count` other forms of the lemma, the lemma itself included, most
 * confusable first. A second spelling of the answer's own cell is never offered.
 */
export function pickDistractors(
  source: DistractorSource,
  pack: LanguageConfig,
  options: { stem?: string | null; count?: number; random?: () => number } = {},
): string[] {
  const { stem = null, count = 3, random = Math.random } = options;
  const { answer, lemma, lemmaPos } = source;
  const answerTags = parseTags(source.answerType);
  const answerTagKey = tagKey(answerTags);
  const answerKey = looseKey(answer, pack);
  const answerHasYo = /ё/i.test(answer);
  const answerAscii = ASCII_LETTER.test(answer);
  const stemKey = stem ? comparisonKey(stem, pack) : null;

  const rows = [{ form: lemma, tags: ['lemma'] }];
  for (const row of source.paradigm) {
    if (isInflectionType(row.type, lemmaPos))
      rows.push({ form: row.form, tags: parseTags(row.type) });
  }

  // One form per loose key. Where two spellings collide, keep the one written
  // the way the answer is: ё only when the answer has ё, then marks over none.
  const byKey = new Map<string, { form: string; tags: string[]; pref: number }>();
  for (const row of rows) {
    const form = normalizeText(row.form);
    if (!WORD_SHAPE.test(form)) continue;
    if (!answerAscii && ASCII_LETTER.test(form)) continue;
    if (tagKey(row.tags) === answerTagKey) continue;
    const key = looseKey(form, pack);
    if (key === answerKey) continue;
    const pref = (/ё/i.test(form) === answerHasYo ? 2 : 0) + (markCount(form) > 0 ? 1 : 0);
    const seen = byKey.get(key);
    if (!seen || pref > seen.pref) byKey.set(key, { form, tags: row.tags, pref });
  }

  const cells = new Set<string>();
  const unique = [...byKey.values()].filter(({ tags }) => {
    const cell = tagKey(tags);
    if (cells.has(cell)) return false;
    cells.add(cell);
    return true;
  });

  const answerTagSet = new Set(answerTags);
  const answerDegree = answerTags.some((tag) => DEGREE_TAGS.has(tag));
  const answerKind = wordKind(answerTags);
  const scored = unique.map(({ form, tags }) => {
    let score = tags.filter((tag) => answerTagSet.has(tag)).length;
    if (stemKey && comparisonKey(form, pack).startsWith(stemKey)) score += 2;
    if (!answerDegree && tags.some((tag) => DEGREE_TAGS.has(tag))) score -= 3;
    // kaikki merges homographs: ru стать the verb shares a paradigm with стать the noun.
    const kind = wordKind(tags);
    if (answerKind && kind && kind !== answerKind) score -= 3;
    return { form, score, tiebreak: random() };
  });
  scored.sort((a, b) => b.score - a.score || a.tiebreak - b.tiebreak);
  return scored.slice(0, count).map((s) => s.form);
}

const TAG_ORDER = [
  'first-person',
  'second-person',
  'third-person',
  'masculine',
  'feminine',
  'neuter',
  'nominative',
  'genitive',
  'dative',
  'accusative',
  'instrumental',
  'prepositional',
  'locative',
  'vocative',
  'singular',
  'plural',
  'present',
  'future',
  'past',
  'aorist',
  'imperfect',
  'perfective',
  'imperfective',
  'indicative',
  'dependent',
  'subjunctive',
  'imperative',
  'active',
  'passive',
  'short-form',
  'adverbial',
  'participle',
  'comparative',
  'superlative',
];

/**
 * Label for a tag list, e.g. "third-person singular aorist". Greek tags the
 * aorist as past + perfective.
 */
export function formatInflectionTags(tags: readonly string[]): string {
  let set = [...new Set(tags.filter((tag) => !VARIANT_TAGS.has(tag)))];
  if (set.includes('past') && set.includes('perfective')) {
    set = [...set.filter((tag) => tag !== 'past' && tag !== 'perfective'), 'aorist'];
  }
  if (set.includes('imperfect')) set = set.filter((tag) => tag !== 'imperfective');
  const rank = (tag: string) => {
    const i = TAG_ORDER.indexOf(tag);
    return i === -1 ? TAG_ORDER.length : i;
  };
  return set
    .sort((a, b) => rank(a) - rank(b))
    .map((tag) => (tag === 'short-form' ? 'short form' : tag))
    .join(' ');
}

/** The prompt shown in the Base form drill: "читать / прочитать", or the lemma. */
export function baseFormPrompt(inflection: Pick<ClozeInflection, 'lemma' | 'aspectPair'>): string {
  return inflection.aspectPair ? inflection.aspectPair.join(' / ') : inflection.lemma;
}

export function supportsInflectionDrills(pack: LanguageConfig): boolean {
  return !!pack.inflection;
}

/** `form` with the answer's initial case, so capitals never give the answer away. */
export function matchInitialCase(form: string, answer: string, pack: LanguageConfig): string {
  const [first = ''] = graphemeSplit(answer);
  const lowered = lowerForPack(form, pack);
  if (first === lowerForPack(first, pack)) return lowered;
  const [head = '', ...rest] = graphemeSplit(lowered);
  // The el locale uppercases έ to Ε, the all-caps spelling. An initial
  // capital keeps the tonos.
  const locale = pack.script.caseFoldLocale;
  return (locale ? head.toLocaleUpperCase(locale) : head.toUpperCase()) + rest.join('');
}
