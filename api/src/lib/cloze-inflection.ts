import { findInflectionSource } from './dictionary-db';
import {
  aspectPair,
  describeForm,
  formatInflectionTags,
  getLanguageConfig,
  isDistinctForm,
  isInflectionType,
  normalizeText,
  parseTags,
  pickDistractors,
  readsAsOwnWord,
  splitEnding,
  type ClozeDrill,
  type ClozeInflection,
  type LanguageCode,
} from './languages';

export type InflectionDrill = Exclude<ClozeDrill, 'word'>;

export function isInflectionDrill(value: unknown): value is InflectionDrill {
  return value === 'ending' || value === 'inflect';
}

function answerWord(clozeWord: string): string {
  return normalizeText(clozeWord).replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, '');
}

/** Null when the answer is not an inflected form, or has no ending for the Ending drill. */
export function clozeInflection(
  clozeWord: string,
  language: LanguageCode,
  drill: InflectionDrill,
): ClozeInflection | null {
  const pack = getLanguageConfig(language);
  if (!pack.inflection) return null;
  const word = answerWord(clozeWord);
  if (!word) return null;

  const source = findInflectionSource(
    word,
    language,
    ({ lemma, type, lemmaPos }) =>
      isInflectionType(type, lemmaPos) && isDistinctForm(word, lemma, pack),
  );
  if (!source || readsAsOwnWord(source.wordSenses, source.lemmaPos)) return null;

  const split = splitEnding(word, source.lemma, pack);
  if (drill === 'ending' && !split) return null;

  const tags = parseTags(source.type);
  return {
    lemma: source.lemma,
    aspectPair: aspectPair(source.lemma, source.paradigm),
    tags,
    description: describeForm(source.wordSenses, source.lemma, pack) ?? formatInflectionTags(tags),
    stem: split?.stem ?? null,
    ending: split?.ending ?? null,
    distractors: pickDistractors({ ...source, answer: word, answerType: source.type }, pack, {
      stem: drill === 'ending' ? split?.stem : null,
    }),
  };
}
