import fs from 'fs';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { db } from '../db';
import { packForLanguage, resolveLanguage } from '../lib/active-language';
import { serveRangedFile } from '../lib/audio-files';
import { config, type LectorMode } from '../lib/config';
import {
  buildConversationReply,
  CONVERSATION_DEFAULT_NEW_PERCENT,
  CONVERSATION_MAX_MESSAGE_LENGTH,
  CONVERSATION_MAX_NEW_PERCENT,
  CONVERSATION_MAX_TOPIC_LENGTH,
  CONVERSATION_MAX_TURNS,
  meterFor,
  type ConversationTurn,
} from '../lib/conversation';
import {
  appendMessage,
  buildRecording,
  createChat,
  deleteChat,
  deleteRecording,
  getChat,
  listChats,
  messageAudioPath,
  recordingPath,
  saveRecording,
} from '../lib/conversation-store';
import { entitlements, planLimitResponse } from '../lib/entitlements';
import { getLanguageConfig, type LanguageConfig } from '../lib/languages';
import { getProvider } from '../lib/llm';
import { ffmpegToolkit, type AudioToolkit } from '../lib/podcast/audio';
import { createPodcastVoice, PodcastLimitError } from '../lib/podcast/engines';
import {
  defaultEngine,
  engineStatuses,
  PODCAST_ENGINES,
  readPodcastSettings,
  type PodcastEngineId,
} from '../lib/podcast/settings';
import type { KnownWord } from '../lib/reading-challenge';
import { getCurrentUserId } from '../lib/user';

/** A learner turn's recording: two minutes of 16 kHz WAV is about 3.9 MB. */
const MAX_TURN_UPLOAD_BYTES = 6 * 1024 * 1024;
const MAX_CHAT_MESSAGES = 400;
const MAX_IMPORT_MESSAGES = 200;

type ReplyOutcome =
  | { ok: true; message: ReturnType<typeof appendMessage> }
  | { ok: false; response: Response };

function parseNewPercent(value: unknown): number | string {
  const newPercent = value ?? CONVERSATION_DEFAULT_NEW_PERCENT;
  if (
    typeof newPercent !== 'number' ||
    !Number.isFinite(newPercent) ||
    newPercent < 0 ||
    newPercent > CONVERSATION_MAX_NEW_PERCENT
  ) {
    return `newPercent must be a number from 0 to ${CONVERSATION_MAX_NEW_PERCENT}`;
  }
  return newPercent;
}

function parseText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().length <= CONVERSATION_MAX_MESSAGE_LENGTH ? value.trim() : null;
}

function parseEngine(value: unknown): PodcastEngineId | null {
  return typeof value === 'string' && (PODCAST_ENGINES as readonly string[]).includes(value)
    ? (value as PodcastEngineId)
    : null;
}

export function makeConversationRoutes(
  mode: LectorMode = config.mode,
  toolkit: AudioToolkit = ffmpegToolkit(),
): Hono {
  const app = new Hono();

  /** The engine's voice for a partner turn, or an error response. */
  function voiceFor(c: Context, userId: string, pack: LanguageConfig, engine: unknown) {
    const id = parseEngine(engine);
    if (!id) {
      return {
        error: c.json({ error: `engine must be one of: ${PODCAST_ENGINES.join(', ')}` }, 400),
      };
    }
    const settings = readPodcastSettings(userId);
    const status = engineStatuses(settings, pack, mode)[id];
    if (!status.configured) {
      return { error: c.json({ error: status.reason ?? 'This voice engine is not set up' }, 400) };
    }
    return { voice: createPodcastVoice(userId, id, settings, pack) };
  }

  /** Writes the partner's next turn after the stored history. */
  async function reply(
    c: Context,
    userId: string,
    chatId: string,
    language: string,
    newPercent: number,
  ): Promise<ReplyOutcome> {
    const chat = getChat(userId, chatId)!;
    const verdict = entitlements.reserve(userId, 'llmRequestsPerMonth');
    if (!verdict.allowed) return { ok: false, response: planLimitResponse(c, verdict) };
    const pack = packForLanguage(language);
    const known = db
      .prepare('SELECT word, state FROM knownWords WHERE userId = ? AND language = ?')
      .all(userId, language) as KnownWord[];
    const history: ConversationTurn[] = chat.messages
      .slice(-CONVERSATION_MAX_TURNS)
      .map((m) => ({ role: m.role, text: m.text }));
    try {
      const result = await buildConversationReply(
        getProvider(userId, { byok: verdict.reservation.byok }),
        { history, known, pack, newPercent, topic: chat.chat.topic },
        meterFor(`${userId}\0${language}`, known, pack),
      );
      if (!result) {
        entitlements.refund(verdict.reservation);
        return {
          ok: false,
          response: c.json(
            { error: 'The AI returned no reply. Try again.', code: 'NO_REPLY' },
            502,
          ),
        };
      }
      const message = appendMessage(userId, chatId, {
        role: 'assistant',
        text: result.reply,
        translation: result.translation,
        newPercent: result.newPercent,
        newWords: result.newWords,
      });
      return { ok: true, message };
    } catch (error) {
      entitlements.refund(verdict.reservation);
      console.error('Conversation reply error:', error);
      return {
        ok: false,
        response: c.json(
          { error: 'Could not get a reply. Check the AI provider in Settings.' },
          502,
        ),
      };
    }
  }

  function ownedChat(c: Context, userId: string) {
    const chat = getChat(userId, c.req.param('id') ?? '');
    return chat;
  }

  // GET /api/conversation/voices — which engines can read replies aloud.
  app.get('/voices', (c) => {
    const userId = getCurrentUserId(c);
    const pack = getLanguageConfig(resolveLanguage(c.req.query('language'), userId));
    const settings = readPodcastSettings(userId);
    const engines = engineStatuses(settings, pack, mode);
    return c.json({ engines, defaultEngine: defaultEngine(settings, engines) });
  });

  // POST /api/conversation/speak — a reply read aloud by the chosen engine, as MP3.
  app.post('/speak', async (c) => {
    const userId = getCurrentUserId(c);
    const pack = getLanguageConfig(resolveLanguage(c.req.query('language'), userId));
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; engine?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return c.json({ error: 'text is required' }, 400);
    }
    if (body.text.length > CONVERSATION_MAX_MESSAGE_LENGTH) {
      return c.json(
        { error: `text may be at most ${CONVERSATION_MAX_MESSAGE_LENGTH} characters` },
        400,
      );
    }
    const resolved = voiceFor(c, userId, pack, body.engine);
    if (resolved.error) return resolved.error;
    try {
      const audio = await resolved.voice.speak(body.text.trim(), 'target');
      return c.body(Buffer.from(audio), 200, { 'Content-Type': 'audio/mpeg' });
    } catch (err) {
      if (err instanceof PodcastLimitError) return c.json({ error: err.message }, 402);
      return c.json({ error: err instanceof Error ? err.message : 'The voice engine failed' }, 502);
    }
  });

  // GET /api/conversation/chats — saved conversations in the active language, newest first.
  app.get('/chats', (c) => {
    const userId = getCurrentUserId(c);
    const language = resolveLanguage(c.req.query('language'), userId);
    return c.json({ chats: listChats(userId, language) });
  });

  // POST /api/conversation/chats — start a conversation; the partner speaks first.
  app.post('/chats', async (c) => {
    const userId = getCurrentUserId(c);
    const language = resolveLanguage(c.req.query('language'), userId);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const newPercent = parseNewPercent(body.newPercent);
    if (typeof newPercent === 'string') return c.json({ error: newPercent }, 400);
    const topic = body.topic ?? '';
    if (typeof topic !== 'string' || topic.length > CONVERSATION_MAX_TOPIC_LENGTH) {
      return c.json(
        { error: `topic must be text of at most ${CONVERSATION_MAX_TOPIC_LENGTH} characters` },
        400,
      );
    }
    const id = createChat(userId, language, topic.trim());
    const outcome = await reply(c, userId, id, language, newPercent);
    if (!outcome.ok) {
      deleteChat(userId, id);
      return outcome.response;
    }
    return c.json(getChat(userId, id), 201);
  });

  // POST /api/conversation/chats/import — save a conversation kept in the browser.
  app.post('/chats/import', async (c) => {
    const userId = getCurrentUserId(c);
    const language = resolveLanguage(c.req.query('language'), userId);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const topic = typeof body.topic === 'string' ? body.topic.trim().slice(0, 200) : '';
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length === 0 || messages.length > MAX_IMPORT_MESSAGES) {
      return c.json(
        { error: `messages must hold 1 to ${MAX_IMPORT_MESSAGES} turns` },
        400,
      );
    }
    const turns = messages.map((m) => {
      const { role, text, translation, newPercent, newWords } = (m ?? {}) as Record<
        string,
        unknown
      >;
      const clean = parseText(text);
      if ((role !== 'user' && role !== 'assistant') || !clean) return null;
      return {
        role: role as 'user' | 'assistant',
        text: clean,
        translation: typeof translation === 'string' ? translation.slice(0, 2000) : null,
        newPercent: typeof newPercent === 'number' && Number.isFinite(newPercent) ? newPercent : null,
        newWords: Array.isArray(newWords)
          ? newWords.filter((w): w is string => typeof w === 'string').slice(0, 100)
          : [],
      };
    });
    if (turns.some((t) => t === null)) {
      return c.json({ error: 'each turn needs a role of user or assistant and some text' }, 400);
    }
    const id = createChat(userId, language, topic);
    for (const turn of turns) appendMessage(userId, id, turn!);
    return c.json(getChat(userId, id), 201);
  });

  // GET /api/conversation/chats/:id — one conversation with its messages.
  app.get('/chats/:id', (c) => {
    const chat = ownedChat(c, getCurrentUserId(c));
    return chat ? c.json(chat) : c.json({ error: 'Conversation not found' }, 404);
  });

  // DELETE /api/conversation/chats/:id — the conversation, its recordings and its stitched audio.
  app.delete('/chats/:id', (c) => {
    const deleted = deleteChat(getCurrentUserId(c), c.req.param('id'));
    return deleted ? c.json({ success: true }) : c.json({ error: 'Conversation not found' }, 404);
  });

  // POST /api/conversation/chats/:id/turns — the learner's turn (multipart: text,
  // newPercent, optional audio), then the partner's reply.
  app.post(
    '/chats/:id/turns',
    bodyLimit({
      maxSize: MAX_TURN_UPLOAD_BYTES,
      onError: (c) => c.json({ error: 'The recording is too large.' }, 413),
    }),
    async (c) => {
      const userId = getCurrentUserId(c);
      const chat = ownedChat(c, userId);
      if (!chat) return c.json({ error: 'Conversation not found' }, 404);
      if (chat.messages.length >= MAX_CHAT_MESSAGES) {
        return c.json({ error: 'This conversation is full. Start a new one.' }, 409);
      }
      if (chat.messages.at(-1)?.role === 'user') {
        return c.json({ error: 'Wait for the reply to your last turn', code: 'AWAITING_REPLY' }, 409);
      }
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json({ error: 'Send the turn as multipart form data' }, 400);
      }
      const text = parseText(form.get('text'));
      if (!text) {
        return c.json(
          { error: `text is required, at most ${CONVERSATION_MAX_MESSAGE_LENGTH} characters` },
          400,
        );
      }
      const rawPercent = form.get('newPercent');
      const newPercent = parseNewPercent(rawPercent === null ? undefined : Number(rawPercent));
      if (typeof newPercent === 'string') return c.json({ error: newPercent }, 400);

      let audioPath: string | null = null;
      const audio = form.get('audio');
      if (audio && typeof audio !== 'string') {
        try {
          audioPath = await saveRecording(
            chat.chat.id,
            new Uint8Array(await audio.arrayBuffer()),
            toolkit,
          );
        } catch (err) {
          console.error('Conversation recording error:', err);
        }
      }
      const user = appendMessage(userId, chat.chat.id, { role: 'user', text, audioPath });
      const outcome = await reply(c, userId, chat.chat.id, chat.language, newPercent);
      if (!outcome.ok) return outcome.response;
      return c.json({ messages: [user, outcome.message] });
    },
  );

  // POST /api/conversation/chats/:id/reply — retry the reply to the learner's last turn.
  app.post('/chats/:id/reply', async (c) => {
    const userId = getCurrentUserId(c);
    const chat = ownedChat(c, userId);
    if (!chat) return c.json({ error: 'Conversation not found' }, 404);
    if (chat.messages.at(-1)?.role !== 'user') {
      return c.json({ error: 'The last turn already has a reply' }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const newPercent = parseNewPercent(body.newPercent);
    if (typeof newPercent === 'string') return c.json({ error: newPercent }, 400);
    const outcome = await reply(c, userId, chat.chat.id, chat.language, newPercent);
    if (!outcome.ok) return outcome.response;
    return c.json({ messages: [outcome.message] });
  });

  // GET /api/conversation/chats/:id/messages/:idx/audio — the learner's recording of one turn.
  app.get('/chats/:id/messages/:idx/audio', async (c) => {
    const userId = getCurrentUserId(c);
    const idx = Number(c.req.param('idx'));
    const file = Number.isInteger(idx) ? messageAudioPath(userId, c.req.param('id'), idx) : null;
    if (!file || !fs.existsSync(file)) return c.json({ error: 'No recording' }, 404);
    return serveRangedFile(Bun.file(file), 'audio/mpeg', c.req.header('range'));
  });

  // POST /api/conversation/chats/:id/recording — stitch every turn into one MP3.
  app.post('/chats/:id/recording', async (c) => {
    const userId = getCurrentUserId(c);
    const chat = ownedChat(c, userId);
    if (!chat) return c.json({ error: 'Conversation not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { engine?: unknown };
    const resolved = voiceFor(c, userId, packForLanguage(chat.language), body.engine);
    if (resolved.error) return resolved.error;
    try {
      const recording = await buildRecording(
        userId,
        chat.chat.id,
        (text) => resolved.voice.speak(text, 'target'),
        toolkit,
      );
      if (!recording) return c.json({ error: 'This conversation has no audio yet' }, 400);
      return c.json({ recording });
    } catch (err) {
      if (err instanceof PodcastLimitError) return c.json({ error: err.message }, 402);
      console.error('Conversation stitching error:', err);
      return c.json(
        { error: err instanceof Error ? err.message : 'Could not build the recording' },
        502,
      );
    }
  });

  // GET /api/conversation/chats/:id/recording — the stitched MP3, range-seekable.
  app.get('/chats/:id/recording', async (c) => {
    const file = recordingPath(getCurrentUserId(c), c.req.param('id'));
    if (!file || !fs.existsSync(file)) return c.json({ error: 'No recording' }, 404);
    return serveRangedFile(Bun.file(file), 'audio/mpeg', c.req.header('range'));
  });

  // DELETE /api/conversation/chats/:id/recording — drop the stitched MP3; the chat stays.
  app.delete('/chats/:id/recording', (c) => {
    const deleted = deleteRecording(getCurrentUserId(c), c.req.param('id'));
    return deleted ? c.json({ success: true }) : c.json({ error: 'No recording' }, 404);
  });

  return app;
}

export default makeConversationRoutes();
