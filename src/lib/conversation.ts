import { apiFetch, apiUrl } from './api-base';
import { getActiveLanguage } from './data-layer';
import { PODCAST_ENGINES, type EngineStatus, type PodcastEngineId } from './podcast';

export const CONVERSATION_NEW_PERCENT_KEY = 'lector-conversation-new-percent';
export const CONVERSATION_VOICE_KEY = 'lector-conversation-voice';
export const CONVERSATION_AUTOPLAY_KEY = 'lector-conversation-autoplay';
export const CONVERSATION_STOP_MODE_KEY = 'lector-conversation-stop-mode';
export const CONVERSATION_PAUSE_KEY = 'lector-conversation-pause-seconds';
// Mirrors the limits in api/src/lib/conversation.ts.
export const CONVERSATION_DEFAULT_NEW_PERCENT = 3;
export const CONVERSATION_MAX_NEW_PERCENT = 20;
export const CONVERSATION_MAX_MESSAGE_LENGTH = 1000;
/** Mirrors MAX_SESSION_SECONDS in api/src/lib/stt.ts. */
export const CONVERSATION_MAX_SPEECH_SECONDS = 120;
/** Seconds of silence that end a spoken turn in auto-stop mode. */
export const CONVERSATION_DEFAULT_PAUSE_SECONDS = 2.5;
export const CONVERSATION_MIN_PAUSE_SECONDS = 1;
export const CONVERSATION_MAX_PAUSE_SECONDS = 8;
export const CONVERSATION_PAUSE_STEP = 0.5;

/** 'auto' ends a spoken turn at a pause; 'manual' waits for the stop button. */
export type ConversationStopMode = 'auto' | 'manual';

export interface ConversationMessage {
  idx: number;
  role: 'user' | 'assistant';
  text: string;
  /** Partner turns only. */
  translation: string | null;
  newPercent: number | null;
  newWords: string[];
  /** The learner's own recording of the turn. */
  hasAudio: boolean;
  createdAt: string;
}

export interface ChatSummary {
  id: string;
  topic: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  /** The stitched recording; `messages` is how many turns it covers. */
  recording: { durationMs: number; messages: number } | null;
}

export interface Chat {
  chat: ChatSummary;
  language: string;
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

export function getConversationStopMode(): ConversationStopMode {
  return read(CONVERSATION_STOP_MODE_KEY) === 'manual' ? 'manual' : 'auto';
}

export function getConversationPauseSeconds(): number {
  const raw = read(CONVERSATION_PAUSE_KEY);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) &&
    value >= CONVERSATION_MIN_PAUSE_SECONDS &&
    value <= CONVERSATION_MAX_PAUSE_SECONDS
    ? value
    : CONVERSATION_DEFAULT_PAUSE_SECONDS;
}

/** The engine to read replies with: the saved one when it works, else the server's pick. */
export function pickEngine(voices: ConversationVoices | null): PodcastEngineId | null {
  if (!voices) return null;
  const saved = getConversationVoice();
  return saved && voices.engines[saved]?.configured ? saved : voices.defaultEngine;
}

async function errorFrom(res: Response, fallback: string): Promise<ConversationError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  return new ConversationError(data.error || fallback, data.code);
}

async function call<T>(path: string, init?: RequestInit, fallback = 'Something went wrong') {
  const join = path.includes('?') ? '&' : '?';
  const res = await apiFetch(
    `/api/conversation${path}${join}language=${getActiveLanguage()}`,
    init,
  );
  if (!res.ok) throw await errorFrom(res, fallback);
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function fetchConversationVoices(): Promise<ConversationVoices> {
  return call('/voices', undefined, 'Could not load the voices');
}

export async function listChats(): Promise<ChatSummary[]> {
  return (await call<{ chats: ChatSummary[] }>('/chats')).chats;
}

export function getChat(id: string): Promise<Chat> {
  return call(`/chats/${id}`, undefined, 'Could not open the conversation');
}

export function createChat(topic: string, newPercent: number): Promise<Chat> {
  return call('/chats', json('POST', { topic, newPercent }), 'Could not start the conversation');
}

export function deleteChat(id: string): Promise<unknown> {
  return call(`/chats/${id}`, { method: 'DELETE' }, 'Could not delete the conversation');
}

/** The learner's turn and the partner's reply. A failed reply leaves the turn saved. */
export async function sendTurn(
  id: string,
  text: string,
  newPercent: number,
  recording: Blob | null,
): Promise<ConversationMessage[]> {
  const form = new FormData();
  form.append('text', text);
  form.append('newPercent', String(newPercent));
  if (recording) form.append('audio', recording, 'turn.wav');
  const result = await call<{ messages: ConversationMessage[] }>(
    `/chats/${id}/turns`,
    { method: 'POST', body: form },
    'Could not get a reply',
  );
  return result.messages;
}

export async function retryReply(id: string, newPercent: number): Promise<ConversationMessage[]> {
  const result = await call<{ messages: ConversationMessage[] }>(
    `/chats/${id}/reply`,
    json('POST', { newPercent }),
    'Could not get a reply',
  );
  return result.messages;
}

export async function buildChatRecording(
  id: string,
  engine: PodcastEngineId,
): Promise<NonNullable<ChatSummary['recording']>> {
  const result = await call<{ recording: NonNullable<ChatSummary['recording']> }>(
    `/chats/${id}/recording`,
    json('POST', { engine }),
    'Could not build the recording',
  );
  return result.recording;
}

export function deleteChatRecording(id: string): Promise<unknown> {
  return call(`/chats/${id}/recording`, { method: 'DELETE' }, 'Could not delete the recording');
}

/** `version` busts the browser cache after a rebuild. */
export function chatRecordingUrl(id: string, version: string | number): string {
  return apiUrl(`/api/conversation/chats/${id}/recording?v=${encodeURIComponent(version)}`);
}

export function messageAudioUrl(id: string, idx: number): string {
  return apiUrl(`/api/conversation/chats/${id}/messages/${idx}/audio`);
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

const legacyKey = (language: string) => `lector-conversation:${language}`;

const imports = new Map<string, Promise<Chat | null>>();

/** Moves a conversation kept in this browser by earlier versions onto the server, once. */
export function importBrowserConversation(language: string): Promise<Chat | null> {
  const running = imports.get(language);
  if (running) return running;
  const job = importOnce(language).finally(() => imports.delete(language));
  imports.set(language, job);
  return job;
}

async function importOnce(language: string): Promise<Chat | null> {
  let saved: { topic?: unknown; messages?: unknown } | null = null;
  try {
    saved = JSON.parse(read(legacyKey(language)) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved || !Array.isArray(saved.messages) || saved.messages.length === 0) return null;
  const chat = await call<Chat>(
    '/chats/import',
    json('POST', { topic: saved.topic ?? '', messages: saved.messages }),
    'Could not save the earlier conversation',
  );
  try {
    localStorage.removeItem(legacyKey(language));
  } catch {
    // Blocked storage: the import may repeat next visit, which only adds a copy.
  }
  return chat;
}
