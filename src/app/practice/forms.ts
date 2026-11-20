import { apiFetch } from '@/lib/api-base';
import { getActiveLanguage } from '@/lib/data-layer';
import { stripMarks, type LanguageConfig, type Paradigm } from '@/lib/languages';
import { normalize } from './utils';

export type FormsKind = 'noun' | 'verb';
export type FormsAnswerMode = 'type' | 'voice';
export const FORMS_KINDS_KEY = 'lector-forms-kinds';
export const FORMS_MODE_KEY = 'lector-forms-mode';
export const FORMS_COUNT_KEY = 'lector-forms-count';
export const FORMS_COUNT_OPTIONS = [10, 20] as const;

export interface FormsItem {
  lemma: string;
  gloss: string | null;
  kind: FormsKind;
  tags: string[];
  /** The form to produce, e.g. "genitive plural". */
  prompt: string;
  answers: string[];
  paradigm: Paradigm;
}

/** 'accent': right letters, wrong or missing accent or ё. */
export type FormsGrade = 'correct' | 'accent' | 'wrong';

export class FormsError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function gradeForm(answer: string, forms: readonly string[], pack: LanguageConfig): FormsGrade {
  const typed = normalize(answer, pack);
  if (!typed) return 'wrong';
  if (forms.some((f) => normalize(f, pack) === typed)) return 'correct';
  const loose = stripMarks(typed);
  return forms.some((f) => stripMarks(normalize(f, pack)) === loose) ? 'accent' : 'wrong';
}

/** A spoken answer passes when any heard word is one of the forms, accents aside. */
export function gradeSpokenForm(
  transcript: string,
  forms: readonly string[],
  pack: LanguageConfig,
): boolean {
  const heard = transcript.split(/\s+/).filter(Boolean);
  return [transcript, ...heard].some((w) => gradeForm(w, forms, pack) !== 'wrong');
}

function readList<T extends string>(key: string, allowed: readonly T[], fallback: T[]): T[] {
  try {
    const stored = (localStorage.getItem(key) ?? '').split(',') as T[];
    const valid = stored.filter((v) => allowed.includes(v));
    return valid.length > 0 ? valid : fallback;
  } catch {
    return fallback;
  }
}

export function getFormsKinds(): FormsKind[] {
  return readList(FORMS_KINDS_KEY, ['noun', 'verb'], ['noun']);
}

export function getFormsMode(): FormsAnswerMode {
  return readList(FORMS_MODE_KEY, ['type', 'voice'], ['type'])[0];
}

export function getFormsCount(): number {
  try {
    const stored = Number(localStorage.getItem(FORMS_COUNT_KEY));
    return (FORMS_COUNT_OPTIONS as readonly number[]).includes(stored) ? stored : 10;
  } catch {
    return 10;
  }
}

export async function fetchFormsRound(kinds: readonly FormsKind[], count: number): Promise<FormsItem[]> {
  const params = new URLSearchParams({
    kinds: kinds.join(','),
    count: String(count),
    language: getActiveLanguage(),
  });
  const res = await apiFetch(`/api/forms/round?${params}`);
  const data = (await res.json().catch(() => ({}))) as {
    items?: FormsItem[];
    error?: string;
    code?: string;
  };
  if (!res.ok || !data.items) throw new FormsError(data.error || 'Could not load a round', data.code);
  return data.items;
}

export function recordFormsAnswer(): void {
  apiFetch(`/api/forms/answer?language=${getActiveLanguage()}`, { method: 'POST' }).catch(() => {});
}
