import { apiFetch } from './api-base';
import { getActiveLanguage } from './data-layer';

export const READING_WORDS_KEY = 'lector-reading-challenge-words';
export const READING_NEW_PERCENT_KEY = 'lector-reading-challenge-new-percent';
// Mirrors the limits in api/src/lib/reading-challenge.ts.
export const READING_DEFAULT_WORDS = 200;
export const READING_MIN_WORDS = 100;
export const READING_MAX_WORDS = 600;
export const READING_WORDS_STEP = 50;
export const READING_DEFAULT_NEW_PERCENT = 5;
export const READING_MAX_NEW_PERCENT = 20;

export interface ReadingChallenge {
  day: string;
  lessonId: string;
  collectionId: string;
  title: string;
  wordCount: number;
  targetNewPercent: number;
  newPercent: number;
  /** Folded words the text uses outside the learner's vocabulary. */
  newWords: string[];
  /** Reading progress, 0-100. */
  progress: number;
}

export interface ReadingChallengeToday {
  day: string;
  challenge: ReadingChallenge | null;
}

export class ReadingChallengeError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function readSetting(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    const stored = raw === null ? NaN : Number(raw);
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function getReadingWords(): number {
  const words = readSetting(
    READING_WORDS_KEY,
    READING_DEFAULT_WORDS,
    READING_MIN_WORDS,
    READING_MAX_WORDS,
  );
  return Number.isInteger(words) ? words : READING_DEFAULT_WORDS;
}

export function getReadingNewPercent(): number {
  return readSetting(
    READING_NEW_PERCENT_KEY,
    READING_DEFAULT_NEW_PERCENT,
    0,
    READING_MAX_NEW_PERCENT,
  );
}

async function call<T>(init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/api/reading-challenge/today?language=${getActiveLanguage()}`, init);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ReadingChallengeError(data.error || 'Something went wrong', data.code);
  }
  return res.json() as Promise<T>;
}

export function getReadingChallenge(): Promise<ReadingChallengeToday> {
  return call();
}

export function startReadingChallenge(
  words: number,
  newPercent: number,
): Promise<ReadingChallengeToday> {
  return call({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words, newPercent }),
  });
}
