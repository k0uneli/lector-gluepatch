import { apiFetch } from './api-base';
import { getActiveLanguage } from './data-layer';
import type { WordState } from '@/types';

export const RECALL_COUNT_KEY = 'lector-recall-daily-count';
export const RECALL_DEFAULT_COUNT = 10;
export const RECALL_COUNT_OPTIONS = [5, 10, 15, 20] as const;

export interface RecallFeedback {
  corrected: string;
  notes: Array<{ original: string; corrected: string; explanation: string }>;
  missed: string[];
}

export interface RecallItem {
  idx: number;
  english: string;
  /** Vocab words the sentence practises. */
  words: string[];
  /** '' when the learner gave up; null until answered. */
  answer: string | null;
  correct: boolean | null;
  /** The AI's verdict; null when the learner gave up. */
  aiCorrect: boolean | null;
  reference: string | null;
  feedback: RecallFeedback | null;
  vocabChanges: Array<{ text: string; from: WordState; to: WordState }>;
}

export interface RecallChallenge {
  day: string;
  items: RecallItem[];
}

export class RecallError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function getRecallDailyCount(): number {
  try {
    const stored = Number(localStorage.getItem(RECALL_COUNT_KEY));
    return Number.isInteger(stored) && stored >= 1 && stored <= 30 ? stored : RECALL_DEFAULT_COUNT;
  } catch {
    return RECALL_DEFAULT_COUNT;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/api/recall${path}?language=${getActiveLanguage()}`, init);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new RecallError(data.error || 'Something went wrong', data.code);
  }
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function getRecallToday(): Promise<RecallChallenge> {
  return call('/today');
}

export function startRecallToday(count: number): Promise<RecallChallenge> {
  return call('/today', json('POST', { count }));
}

export function answerRecall(
  day: string,
  idx: number,
  answer: string,
  giveUp = false,
): Promise<RecallItem> {
  return call(`/${day}/${idx}/answer`, json('POST', { answer, giveUp }));
}

export function setRecallVerdict(day: string, idx: number, correct: boolean): Promise<RecallItem> {
  return call(`/${day}/${idx}/verdict`, json('PUT', { correct }));
}
