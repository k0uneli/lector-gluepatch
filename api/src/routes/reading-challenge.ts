import { randomUUID } from 'crypto';
import { Hono } from 'hono';
import { db } from '../db';
import { resolveLanguage } from '../lib/active-language';
import { getTodayDate } from '../lib/dates';
import { entitlements, planLimitResponse, type UsageReservation } from '../lib/entitlements';
import { buildSegmentWords, countWords } from '../lib/html-to-markdown';
import { getLanguageConfig, normalizeText, type LanguageConfig } from '../lib/languages';
import { getProvider } from '../lib/llm';
import {
  READING_DEFAULT_NEW_PERCENT,
  READING_DEFAULT_WORDS,
  READING_MAX_NEW_PERCENT,
  READING_MAX_WORDS,
  READING_MIN_KNOWN,
  READING_MIN_WORDS,
  buildReadingChallenge,
  type KnownWord,
  type ReadingChallengeText,
} from '../lib/reading-challenge';
import {
  aggregateGrowthCheck,
  collectionMetadataBytes,
  growingRowCheck,
  lessonTextBytes,
} from '../lib/storage-limits';
import { getCurrentUserId } from '../lib/user';

export const READING_COLLECTION_TITLE = 'Daily Reading';
const AVOID_RECENT = 30;

interface ChallengeRow {
  day: string;
  lessonId: string;
  title: string;
  targetNewPercent: number;
  newPercent: number;
  newWords: string;
  wordCount: number | null;
  progress: number | null;
  collectionId: string | null;
}

function parseWords(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((w) => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

function toDto(row: ChallengeRow) {
  return {
    day: row.day,
    lessonId: row.lessonId,
    collectionId: row.collectionId,
    title: row.title,
    wordCount: row.wordCount ?? 0,
    targetNewPercent: row.targetNewPercent,
    newPercent: row.newPercent,
    newWords: parseWords(row.newWords),
    progress: row.progress ?? 0,
  };
}

/** Today's challenge, or null. A challenge whose lesson was deleted is dropped. */
function todayChallenge(userId: string, language: string, day: string): ChallengeRow | null {
  const row = db
    .prepare(
      `SELECT r.day, r.lessonId, r.title, r.targetNewPercent, r.newPercent, r.newWords,
              l.wordCount, l.progress_percentComplete AS progress, l.collectionId
         FROM reading_challenges r
         LEFT JOIN lessons l ON l.id = r.lessonId AND l.userId = r.userId
        WHERE r.userId = ? AND r.language = ? AND r.day = ?`,
    )
    .get(userId, language, day) as ChallengeRow | null;
  if (row && row.collectionId === null) {
    db.prepare('DELETE FROM reading_challenges WHERE userId = ? AND language = ? AND day = ?').run(
      userId,
      language,
      day,
    );
    return null;
  }
  return row;
}

/** The collection the latest challenge went into, while it still exists. */
function readingCollectionId(userId: string, language: string): string | null {
  const row = db
    .prepare(
      `SELECT l.collectionId FROM reading_challenges r
         JOIN lessons l ON l.id = r.lessonId AND l.userId = r.userId
         JOIN collections c ON c.id = l.collectionId AND c.userId = l.userId
        WHERE r.userId = ? AND r.language = ?
        ORDER BY r.day DESC LIMIT 1`,
    )
    .get(userId, language) as { collectionId: string } | null;
  return row?.collectionId ?? null;
}

function saveChallenge(
  userId: string,
  language: string,
  pack: LanguageConfig,
  day: string,
  targetNewPercent: number,
  result: ReadingChallengeText,
) {
  const now = new Date().toISOString();
  const lessonId = randomUUID();
  const existingCollection = readingCollectionId(userId, language);
  const collectionId = existingCollection ?? randomUUID();
  const title = normalizeText(result.title || day);
  const lessonTitle = `${day} · ${title}`;
  const textContent = normalizeText(result.text);
  const contentBytes = lessonTextBytes(textContent, lessonTitle);

  return entitlements.reserveCount(
    userId,
    [
      ...(existingCollection
        ? []
        : [
            { metric: 'maxCollections' as const },
            ...growingRowCheck(
              'maxCollectionMetadataBytes',
              collectionMetadataBytes({ title: READING_COLLECTION_TITLE, author: 'Lector', coverUrl: null }),
            ),
          ]),
      { metric: 'maxLessons' },
      ...growingRowCheck('maxLessonTextBytes', contentBytes),
      ...aggregateGrowthCheck('maxLessonTextBytesTotal', contentBytes),
    ],
    () => {
      if (!existingCollection) {
        db.prepare(
          `INSERT INTO collections (id, title, author, coverUrl, groupId, language, createdAt, lastReadAt, userId)
           VALUES (?, ?, 'Lector', NULL, NULL, ?, ?, ?, ?)`,
        ).run(collectionId, READING_COLLECTION_TITLE, language, now, now, userId);
      }
      const { nextOrder } = db
        .prepare(
          'SELECT COALESCE(MAX(sortOrder), -1) + 1 AS nextOrder FROM lessons WHERE collectionId = ? AND userId = ?',
        )
        .get(collectionId, userId) as { nextOrder: number };
      db.prepare(
        `INSERT INTO lessons (id, collectionId, title, sortOrder, textContent, wordCount, segmentWords, language, createdAt, lastReadAt, userId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        lessonId,
        collectionId,
        lessonTitle,
        nextOrder,
        textContent,
        countWords(textContent, pack),
        buildSegmentWords(textContent, pack),
        language,
        now,
        now,
        userId,
      );
      db.prepare('UPDATE collections SET lastReadAt = ? WHERE id = ? AND userId = ?').run(
        now,
        collectionId,
        userId,
      );
      db.prepare(
        `INSERT INTO reading_challenges
           (userId, language, day, lessonId, title, targetNewPercent, newPercent, newWords, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        language,
        day,
        lessonId,
        title,
        targetNewPercent,
        result.newPercent,
        JSON.stringify(result.newWords),
        now,
      );
    },
  );
}

function validateSettings(body: { words?: unknown; newPercent?: unknown }) {
  const words = body.words ?? READING_DEFAULT_WORDS;
  const newPercent = body.newPercent ?? READING_DEFAULT_NEW_PERCENT;
  if (
    !Number.isInteger(words) ||
    (words as number) < READING_MIN_WORDS ||
    (words as number) > READING_MAX_WORDS
  ) {
    return {
      error: `words must be a whole number from ${READING_MIN_WORDS} to ${READING_MAX_WORDS}`,
    };
  }
  if (
    typeof newPercent !== 'number' ||
    !Number.isFinite(newPercent) ||
    newPercent < 0 ||
    newPercent > READING_MAX_NEW_PERCENT
  ) {
    return { error: `newPercent must be a number from 0 to ${READING_MAX_NEW_PERCENT}` };
  }
  return { words: words as number, newPercent };
}

const generating = new Map<string, Promise<unknown>>();

const app = new Hono();

// GET /api/reading-challenge/today — today's challenge, null until it is generated.
app.get('/today', (c) => {
  const userId = getCurrentUserId(c);
  const language = resolveLanguage(c.req.query('language'), userId);
  const day = getTodayDate(userId);
  const row = todayChallenge(userId, language, day);
  return c.json({ day, challenge: row ? toDto(row) : null });
});

// POST /api/reading-challenge/today — write today's text, or return it when it exists.
app.post('/today', async (c) => {
  const userId = getCurrentUserId(c);
  const language = resolveLanguage(c.req.query('language'), userId);
  const day = getTodayDate(userId);
  const body = (await c.req.json().catch(() => ({}))) as { words?: unknown; newPercent?: unknown };
  const settings = validateSettings(body);
  if ('error' in settings) return c.json({ error: settings.error }, 400);

  const key = `${userId}\0${language}\0${day}`;
  const inFlight = generating.get(key);
  if (inFlight) await inFlight.catch(() => {});
  const existing = todayChallenge(userId, language, day);
  if (existing) return c.json({ day, challenge: toDto(existing) });

  const known = db
    .prepare(`SELECT word, state FROM knownWords WHERE userId = ? AND language = ?`)
    .all(userId, language) as KnownWord[];
  const usable = known.filter((k) => k.state !== 'new' && k.state !== 'ignored').length;
  if (usable < READING_MIN_KNOWN) {
    return c.json(
      {
        error: `Mark at least ${READING_MIN_KNOWN} words as known or learning to get a reading challenge.`,
        code: 'NOT_ENOUGH_VOCAB',
      },
      400,
    );
  }

  const verdict = entitlements.reserve(userId, 'llmRequestsPerMonth');
  if (!verdict.allowed) return planLimitResponse(c, verdict);
  let reservation: UsageReservation | null = verdict.reservation;

  const pack = getLanguageConfig(language);
  const avoidTitles = (
    db
      .prepare(
        'SELECT title FROM reading_challenges WHERE userId = ? AND language = ? ORDER BY day DESC LIMIT ?',
      )
      .all(userId, language, AVOID_RECENT) as Array<{ title: string }>
  ).map((r) => r.title);

  const job = (async () => {
    const result = await buildReadingChallenge(
      getProvider(userId, { byok: reservation!.byok }),
      { known, pack, words: settings.words, newPercent: settings.newPercent, avoidTitles },
    );
    reservation = null;
    return result && saveChallenge(userId, language, pack, day, settings.newPercent, result);
  })();
  generating.set(key, job);
  let saved: Awaited<typeof job>;
  try {
    saved = await job;
  } catch (error) {
    if (reservation) entitlements.refund(reservation);
    console.error('Reading challenge generation error:', error);
    return c.json(
      { error: 'Could not write today’s text. Check the AI provider in Settings.' },
      502,
    );
  } finally {
    generating.delete(key);
  }
  if (!saved) {
    return c.json({ error: 'The AI returned no text. Try again.', code: 'NO_TEXT' }, 502);
  }
  if (!saved.allowed) return planLimitResponse(c, saved);
  return c.json({ day, challenge: toDto(todayChallenge(userId, language, day)!) });
});

export default app;
