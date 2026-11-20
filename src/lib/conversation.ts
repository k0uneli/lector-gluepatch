import { apiFetch } from './api-base';
import { getActiveLanguage } from './data-layer';
import { PODCAST_ENGINES, type EngineStatus, type PodcastEngineId } from './podcast';

export const CONVERSATION_NEW_PERCENT_KEY = 'lector-conversation-new-percent';
export const CONVERSATION_VOICE_KEY = 'lector-conversation-voice';
export const CONVERSATION_AUTOPLAY_KEY = 'lector-conversation-autoplay';
// Mirrors the limits in api/src/lib/conversation.ts.
export const CONVERSATION_DEFAULT_NEW_PERCENT = 3;
export const CONVERSATION_MAX_NEW_PERCENT = 20;
export const CONVERSATION_MAX_TURNS = 40;
export const CONVERSATION_MAX_MESSAGE_LENGTH = 1000;

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Partner turns only. */
  translation?: string;
  newPercent?: number;
  newWords?: string[];
}

export interface SavedConversation {
  topic: string;
  messages: ConversationMessage[];
}

export interface ConversationVoices {
  engines: Record<PodcastEngineId, EngineStatus>;
  defaultEngine: PodcastEngineId | null;
}

export class ConversationError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getConversationNewPercent(): number {
  const raw = read(CONVERSATION_NEW_PERCENT_KEY);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= CONVERSATION_MAX_NEW_PERCENT
    ? value
    : CONVERSATION_DEFAULT_NEW_PERCENT;
}

/** The saved engine, or null to use the server's default. */
export function getConversationVoice(): PodcastEngineId | null {
  const raw = read(CONVERSATION_VOICE_KEY);
  return (PODCAST_ENGINES as string[]).includes(raw ?? '') ? (raw as PodcastEngineId) : null;
}

export function getConversationAutoplay(): boolean {
  return read(CONVERSATION_AUTOPLAY_KEY) !== 'false';
}

/** The engine to read replies with: the saved one when it works, else the server's pick. */
export function pickEngine(voices: ConversationVoices | null): PodcastEngineId | null {
  if (!voices) return null;
  const saved = getConversationVoice();
  return saved && voices.engines[saved]?.configured ? saved : voices.defaultEngine;
}

const storageKey = (language: string) => `lector-conversation:${language}`;

export function loadConversation(language: string): SavedConversation | null {
  try {
    const parsed = JSON.parse(read(storageKey(language)) ?? 'null') as SavedConversation | null;
    return parsed && Array.isArray(parsed.messages) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveConversation(language: string, conversation: SavedConversation | null): void {
  try {
    if (conversation) localStorage.setItem(storageKey(language), JSON.stringify(conversation));
    else localStorage.removeItem(storageKey(language));
  } catch {
    // Storage full or blocked: the conversation still works for this visit.
  }
}

async function errorFrom(res: Response, fallback: string): Promise<ConversationError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  return new ConversationError(data.error || fallback, data.code);
}

export async function fetchConversationVoices(): Promise<ConversationVoices> {
  const res = await apiFetch(`/api/conversation/voices?language=${getActiveLanguage()}`);
  if (!res.ok) throw await errorFrom(res, 'Could not load the voices');
  return res.json();
}

export async function requestReply(
  messages: readonly ConversationMessage[],
  newPercent: number,
  topic: string,
): Promise<Required<Pick<ConversationMessage, 'text' | 'translation' | 'newPercent' | 'newWords'>>> {
  const history = messages.slice(-CONVERSATION_MAX_TURNS).map(({ role, text }) => ({ role, text }));
  const res = await apiFetch(`/api/conversation/reply?language=${getActiveLanguage()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ history, newPercent, topic }),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not get a reply');
  const data = (await res.json()) as {
    reply: string;
    translation: string;
    newPercent: number;
    newWords: string[];
  };
  return {
    text: data.reply,
    translation: data.translation,
    newPercent: data.newPercent,
    newWords: data.newWords,
  };
}

export async function speakReply(text: string, engine: PodcastEngineId): Promise<Blob> {
  const res = await apiFetch(`/api/conversation/speak?language=${getActiveLanguage()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, engine }),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not read the reply aloud');
  return res.blob();
}
