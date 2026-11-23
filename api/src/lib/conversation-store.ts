import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { CONVERSATION_AUDIO_DIR, db } from '../db';
import { saveAudioFile } from './audio-files';
import type { TurnCorrection } from './conversation';
import { mp3DurationMs, SAMPLE_RATE, type AudioToolkit } from './podcast/audio';

/** Silence between turns in a stitched recording. */
const TURN_GAP_MS = 700;

export interface StoredMessage {
  idx: number;
  role: 'user' | 'assistant';
  text: string;
  translation: string | null;
  newPercent: number | null;
  newWords: string[];
  hasAudio: boolean;
  /** Learner turns checked while corrections were on. */
  correction: TurnCorrection | null;
  createdAt: string;
}

export interface ChatSummary {
  id: string;
  topic: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  recording: { durationMs: number; messages: number } | null;
}

interface ChatRow {
  id: string;
  topic: string;
  createdAt: string;
  updatedAt: string;
  recordingPath: string | null;
  recordingDurationMs: number | null;
  recordingMessages: number | null;
}

interface MessageRow {
  idx: number;
  role: 'user' | 'assistant';
  text: string;
  translation: string | null;
  newPercent: number | null;
  newWords: string | null;
  audioPath: string | null;
  correction: string | null;
  createdAt: string;
}

function parseCorrection(value: string | null): TurnCorrection | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as TurnCorrection;
  } catch {
    return null;
  }
}

function parseWords(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((w) => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

export function chatDir(id: string): string {
  return path.join(CONVERSATION_AUDIO_DIR, id);
}

/** Only paths inside the chat's own folder; a stored path never reaches elsewhere. */
function ownedPath(id: string, file: string | null): string | null {
  if (!file) return null;
  const resolved = path.resolve(file);
  return resolved.startsWith(path.resolve(chatDir(id)) + path.sep) ? resolved : null;
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    idx: row.idx,
    role: row.role,
    text: row.text,
    translation: row.translation,
    newPercent: row.newPercent,
    newWords: parseWords(row.newWords),
    hasAudio: !!row.audioPath,
    correction: parseCorrection(row.correction),
    createdAt: row.createdAt,
  };
}

function toSummary(row: ChatRow & { preview: string | null; messageCount: number }): ChatSummary {
  return {
    id: row.id,
    topic: row.topic,
    preview: row.preview ?? '',
    messageCount: row.messageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    recording:
      row.recordingPath && row.recordingDurationMs !== null
        ? { durationMs: row.recordingDurationMs, messages: row.recordingMessages ?? 0 }
        : null,
  };
}

const SUMMARY_SQL = `SELECT c.*,
    (SELECT text FROM conversation_messages m
      WHERE m.conversationId = c.id AND m.userId = c.userId ORDER BY idx LIMIT 1) AS preview,
    (SELECT COUNT(*) FROM conversation_messages m
      WHERE m.conversationId = c.id AND m.userId = c.userId) AS messageCount
  FROM conversations c`;

export function listChats(userId: string, language: string): ChatSummary[] {
  const rows = db
    .prepare(`${SUMMARY_SQL} WHERE c.userId = ? AND c.language = ? ORDER BY c.updatedAt DESC`)
    .all(userId, language) as Array<ChatRow & { preview: string | null; messageCount: number }>;
  return rows.map(toSummary);
}

export function getChat(
  userId: string,
  id: string,
): { chat: ChatSummary; language: string; messages: StoredMessage[] } | null {
  const row = db.prepare(`${SUMMARY_SQL} WHERE c.id = ? AND c.userId = ?`).get(id, userId) as
    | (ChatRow & { preview: string | null; messageCount: number; language: string })
    | null;
  if (!row) return null;
  const messages = (
    db
      .prepare(
        `SELECT idx, role, text, translation, newPercent, newWords, audioPath, correction, createdAt
           FROM conversation_messages WHERE conversationId = ? AND userId = ? ORDER BY idx`,
      )
      .all(id, userId) as MessageRow[]
  ).map(toMessage);
  return { chat: toSummary(row), language: row.language, messages };
}

export function createChat(userId: string, language: string, topic: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversations (id, userId, language, topic, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, language, topic, now, now);
  return id;
}

export function appendMessage(
  userId: string,
  id: string,
  message: {
    role: 'user' | 'assistant';
    text: string;
    translation?: string | null;
    newPercent?: number | null;
    newWords?: string[];
    audioPath?: string | null;
  },
): StoredMessage {
  const now = new Date().toISOString();
  const { next } = db
    .prepare(
      'SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM conversation_messages WHERE conversationId = ? AND userId = ?',
    )
    .get(id, userId) as { next: number };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO conversation_messages
         (conversationId, userId, idx, role, text, translation, newPercent, newWords, audioPath, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      next,
      message.role,
      message.text,
      message.translation ?? null,
      message.newPercent ?? null,
      JSON.stringify(message.newWords ?? []),
      message.audioPath ?? null,
      now,
    );
    db.prepare('UPDATE conversations SET updatedAt = ? WHERE id = ? AND userId = ?').run(
      now,
      id,
      userId,
    );
  })();
  return toMessage(
    db
      .prepare(
        `SELECT idx, role, text, translation, newPercent, newWords, audioPath, correction, createdAt
           FROM conversation_messages WHERE conversationId = ? AND userId = ? AND idx = ?`,
      )
      .get(id, userId, next) as MessageRow,
  );
}

/** Stores the check of a learner turn; returns the updated message, or null. */
export function setCorrection(
  userId: string,
  id: string,
  idx: number,
  correction: TurnCorrection,
): StoredMessage | null {
  const result = db
    .prepare(
      `UPDATE conversation_messages SET correction = ?
        WHERE conversationId = ? AND userId = ? AND idx = ? AND role = 'user'`,
    )
    .run(JSON.stringify(correction), id, userId, idx);
  if (result.changes === 0) return null;
  return getChat(userId, id)?.messages.find((m) => m.idx === idx) ?? null;
}

export function deleteChat(userId: string, id: string): boolean {
  const deleted = db.transaction(() => {
    const result = db
      .prepare('DELETE FROM conversations WHERE id = ? AND userId = ?')
      .run(id, userId);
    db.prepare('DELETE FROM conversation_messages WHERE conversationId = ? AND userId = ?').run(
      id,
      userId,
    );
    return result.changes > 0;
  })();
  if (deleted) removeChatFiles(id);
  return deleted;
}

export function removeChatFiles(id: string): void {
  const dir = path.resolve(chatDir(id));
  if (!dir.startsWith(path.resolve(CONVERSATION_AUDIO_DIR) + path.sep)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Stores a learner recording (any container) as MP3; returns its path. */
export async function saveRecording(
  id: string,
  audio: Uint8Array,
  toolkit: AudioToolkit,
): Promise<string> {
  const mp3 = await toolkit.encode(await toolkit.decode(audio, 1));
  const file = path.join(chatDir(id), `turn-${randomUUID()}.mp3`);
  await saveAudioFile(file, mp3.buffer as ArrayBuffer);
  return file;
}

export function messageAudioPath(userId: string, id: string, idx: number): string | null {
  const row = db
    .prepare(
      'SELECT audioPath FROM conversation_messages WHERE conversationId = ? AND userId = ? AND idx = ?',
    )
    .get(id, userId, idx) as { audioPath: string | null } | null;
  return ownedPath(id, row?.audioPath ?? null);
}

export function recordingPath(userId: string, id: string): string | null {
  const row = db
    .prepare('SELECT recordingPath FROM conversations WHERE id = ? AND userId = ?')
    .get(id, userId) as { recordingPath: string | null } | null;
  return ownedPath(id, row?.recordingPath ?? null);
}

/**
 * Joins the turns into one MP3, with a pause between them. A learner turn
 * without a recording is skipped; `speak` voices each partner turn.
 */
export async function buildRecording(
  userId: string,
  id: string,
  speak: (text: string) => Promise<Uint8Array>,
  toolkit: AudioToolkit,
): Promise<{ durationMs: number; messages: number } | null> {
  const chat = getChat(userId, id);
  if (!chat || chat.messages.length === 0) return null;
  const gap = new Uint8Array(Math.round((SAMPLE_RATE * TURN_GAP_MS) / 1000) * 2);
  const parts: Uint8Array[] = [];
  for (const message of chat.messages) {
    let source: Uint8Array | null = null;
    if (message.role === 'assistant') {
      source = await speak(message.text);
    } else {
      const file = messageAudioPath(userId, id, message.idx);
      if (file && fs.existsSync(file)) source = new Uint8Array(await Bun.file(file).arrayBuffer());
    }
    if (!source) continue;
    if (parts.length > 0) parts.push(gap);
    parts.push(await toolkit.decode(source, 1));
  }
  if (parts.length === 0) return null;
  const pcm = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    pcm.set(part, offset);
    offset += part.byteLength;
  }
  const mp3 = await toolkit.encode(pcm);
  const file = path.join(chatDir(id), 'conversation.mp3');
  await saveAudioFile(file, mp3.buffer as ArrayBuffer);
  const durationMs = mp3DurationMs(mp3.byteLength);
  db.prepare(
    `UPDATE conversations SET recordingPath = ?, recordingDurationMs = ?, recordingMessages = ?
      WHERE id = ? AND userId = ?`,
  ).run(file, durationMs, chat.messages.length, id, userId);
  return { durationMs, messages: chat.messages.length };
}

export function deleteRecording(userId: string, id: string): boolean {
  const file = recordingPath(userId, id);
  const result = db
    .prepare(
      `UPDATE conversations SET recordingPath = NULL, recordingDurationMs = NULL, recordingMessages = NULL
        WHERE id = ? AND userId = ? AND recordingPath IS NOT NULL`,
    )
    .run(id, userId);
  if (file) fs.rmSync(file, { force: true });
  return result.changes > 0;
}

/** Folders of every chat a tenant owns, for account erasure. */
export function chatIdsFor(userId: string): string[] {
  return (
    db.prepare('SELECT id FROM conversations WHERE userId = ?').all(userId) as Array<{ id: string }>
  ).map((r) => r.id);
}
