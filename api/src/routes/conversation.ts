import { Hono } from 'hono';
import { db } from '../db';
import { resolveLanguage } from '../lib/active-language';
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
import { entitlements, planLimitResponse } from '../lib/entitlements';
import { getLanguageConfig } from '../lib/languages';
import { getProvider } from '../lib/llm';
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

function parseHistory(value: unknown): ConversationTurn[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return 'history must be an array';
  if (value.length > CONVERSATION_MAX_TURNS) {
    return `history may hold at most ${CONVERSATION_MAX_TURNS} turns`;
  }
  const turns: ConversationTurn[] = [];
  for (const item of value) {
    const { role, text } = (item ?? {}) as Record<string, unknown>;
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string' || !text.trim()) {
      return 'each turn needs a role of user or assistant and some text';
    }
    if (text.length > CONVERSATION_MAX_MESSAGE_LENGTH) {
      return `a turn may be at most ${CONVERSATION_MAX_MESSAGE_LENGTH} characters`;
    }
    turns.push({ role, text: text.trim() });
  }
  if (turns.length > 0 && turns.at(-1)!.role !== 'user') {
    return 'the last turn must be the learner’s';
  }
  return turns;
}

export function makeConversationRoutes(mode: LectorMode = config.mode): Hono {
  const app = new Hono();

  // GET /api/conversation/voices — which engines can read replies aloud.
  app.get('/voices', (c) => {
    const userId = getCurrentUserId(c);
    const pack = getLanguageConfig(resolveLanguage(c.req.query('language'), userId));
    const settings = readPodcastSettings(userId);
    const engines = engineStatuses(settings, pack, mode);
    return c.json({ engines, defaultEngine: defaultEngine(settings, engines) });
  });

  // POST /api/conversation/reply — the partner's next turn, limited to the learner's words.
  app.post('/reply', async (c) => {
    const userId = getCurrentUserId(c);
    const language = resolveLanguage(c.req.query('language'), userId);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const history = parseHistory(body.history);
    if (typeof history === 'string') return c.json({ error: history }, 400);
    const newPercent = body.newPercent ?? CONVERSATION_DEFAULT_NEW_PERCENT;
    if (
      typeof newPercent !== 'number' ||
      !Number.isFinite(newPercent) ||
      newPercent < 0 ||
      newPercent > CONVERSATION_MAX_NEW_PERCENT
    ) {
      return c.json(
        { error: `newPercent must be a number from 0 to ${CONVERSATION_MAX_NEW_PERCENT}` },
        400,
      );
    }
    const topic = body.topic ?? '';
    if (typeof topic !== 'string' || topic.length > CONVERSATION_MAX_TOPIC_LENGTH) {
      return c.json(
        { error: `topic must be text of at most ${CONVERSATION_MAX_TOPIC_LENGTH} characters` },
        400,
      );
    }

    const verdict = entitlements.reserve(userId, 'llmRequestsPerMonth');
    if (!verdict.allowed) return planLimitResponse(c, verdict);

    const pack = getLanguageConfig(language);
    const known = db
      .prepare('SELECT word, state FROM knownWords WHERE userId = ? AND language = ?')
      .all(userId, language) as KnownWord[];
    try {
      const reply = await buildConversationReply(
        getProvider(userId, { byok: verdict.reservation.byok }),
        { history, known, pack, newPercent, topic: topic.trim() },
        meterFor(`${userId}\0${language}`, known, pack),
      );
      if (!reply) {
        entitlements.refund(verdict.reservation);
        return c.json({ error: 'The AI returned no reply. Try again.', code: 'NO_REPLY' }, 502);
      }
      return c.json(reply);
    } catch (error) {
      entitlements.refund(verdict.reservation);
      console.error('Conversation reply error:', error);
      return c.json({ error: 'Could not get a reply. Check the AI provider in Settings.' }, 502);
    }
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
    if (
      typeof body.engine !== 'string' ||
      !(PODCAST_ENGINES as readonly string[]).includes(body.engine)
    ) {
      return c.json({ error: `engine must be one of: ${PODCAST_ENGINES.join(', ')}` }, 400);
    }
    const engine = body.engine as PodcastEngineId;
    const settings = readPodcastSettings(userId);
    const status = engineStatuses(settings, pack, mode)[engine];
    if (!status.configured) {
      return c.json({ error: status.reason ?? 'This voice engine is not set up' }, 400);
    }
    try {
      const audio = await createPodcastVoice(userId, engine, settings, pack).speak(
        body.text.trim(),
        'target',
      );
      return c.body(Buffer.from(audio), 200, { 'Content-Type': 'audio/mpeg' });
    } catch (err) {
      if (err instanceof PodcastLimitError) return c.json({ error: err.message }, 402);
      return c.json({ error: err instanceof Error ? err.message : 'The voice engine failed' }, 502);
    }
  });

  return app;
}

export default makeConversationRoutes();
