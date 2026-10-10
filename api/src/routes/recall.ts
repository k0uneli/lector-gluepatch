import { Hono } from 'hono';
import { db, type WordState } from '../db';
import { resolveLanguage } from '../lib/active-language';
import { reserveDailyStatsRows } from '../lib/daily-stats-limits';
import { getTodayDate } from '../lib/dates';
import { entitlements, planLimitResponse, type UsageReservation } from '../lib/entitlements';
import { foldWord, getLanguageConfig, type LanguageConfig } from '../lib/languages';
import { getProvider } from '../lib/llm';
import {
  RECALL_DEFAULT_COUNT,
  RECALL_MAX_COUNT,
  RECALL_MIN_VOCAB,
  buildRecallSentences,
  gradeRecallAnswer,
  vocabChangesFor,
  type RecallGrade,
  type RecallVocab,
  type RecallWord,
  type VocabChange,
} from '../lib/recall';
import { getCurrentUserId } from '../lib/user';

const MAX_ANSWER_LENGTH = 1000;
const AVOID_RECENT = 40;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface RecallItemRow {
  idx: number;
  english: string;
  reference: string;
  words: string;
  answer: string | null;
  correct: number | null;
  aiCorrect: number | null;
  feedback: string | null;
  vocabChanges: string | null;
  answeredAt: string | null;
}

type StoredFeedback = Omit<RecallGrade, 'correct'>;

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** The reference and feedback stay hidden until the item is answered. */
function toDto(row: RecallItemRow) {
  const answered = row.answeredAt !== null;
  return {
    idx: row.idx,
    english: row.english,
    words: parseJson<RecallWord[]>(row.words, []).map((w) => w.text),
    answer: row.answer,
    correct: row.correct === null ? null : row.correct === 1,
    aiCorrect: row.aiCorrect === null ? null : row.aiCorrect === 1,
    reference: answered ? row.reference : null,
    feedback: answered ? parseJson<StoredFeedback | null>(row.feedback, null) : null,
    vocabChanges: answered
      ? parseJson<VocabChange[]>(row.vocabChanges, []).map(({ text, from, to }) => ({
          text,
          from,
          to,
        }))
      : [],
  };
}

function dayItems(userId: string, language: string, day: string): RecallItemRow[] {
  return db
    .prepare(
      `SELECT idx, english, reference, words, answer, correct, aiCorrect, feedback, vocabChanges, answeredAt
         FROM recall_items WHERE userId = ? AND language = ? AND day = ? ORDER BY idx`,
    )
    .all(userId, language, day) as RecallItemRow[];
}

function getItem(userId: string, language: string, day: string, idx: number) {
  return dayItems(userId, language, day).find((row) => row.idx === idx);
}

function practisedVocab(userId: string, words: RecallWord[]): RecallVocab[] {
  const select = db.prepare('SELECT id, text, state FROM vocab WHERE userId = ? AND id = ?');
  return words.flatMap((w) => {
    const row = select.get(userId, w.id) as RecallVocab | undefined;
    return row ? [row] : [];
  });
}

/** Move a word to `to`, but only while it still sits at `expected`. */
function setVocabState(
  userId: string,
  language: string,
  pack: LanguageConfig,
  change: { id: string; text: string; to: WordState },
  expected: WordState,
): void {
  const result = db
    .prepare(
      'UPDATE vocab SET state = ?, stateUpdatedAt = ? WHERE id = ? AND userId = ? AND state = ?',
    )
    .run(change.to, new Date().toISOString(), change.id, userId, expected);
  if (result.changes === 0) return;
  db.prepare('UPDATE knownWords SET state = ? WHERE userId = ? AND word = ? AND language = ?').run(
    change.to,
    userId,
    foldWord(change.text, pack),
    language,
  );
}

function applyChanges(
  userId: string,
  language: string,
  pack: LanguageConfig,
  changes: VocabChange[],
) {
  for (const change of changes) setVocabState(userId, language, pack, change, change.from);
}

function revertChanges(
  userId: string,
  language: string,
  pack: LanguageConfig,
  changes: VocabChange[],
) {
  for (const change of changes) {
    setVocabState(userId, language, pack, { ...change, to: change.from }, change.to);
  }
}

function countPractice(userId: string, language: string, day: string): void {
  reserveDailyStatsRows(userId, [{ date: day, language }], () => {
    db.prepare(
      `INSERT OR IGNORE INTO dailyStats
        (userId, date, language, wordsRead, newWordsSaved, wordsMarkedKnown, minutesRead, clozePracticed, points, dictionaryLookups)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0)`,
    ).run(userId, day, language);
    db.prepare(
      `UPDATE dailyStats SET clozePracticed = clozePracticed + 1
       WHERE userId = ? AND date = ? AND language = ?`,
    ).run(userId, day, language);
  });
}

const generating = new Map<string, Promise<void>>();

const app = new Hono();

// GET /api/recall/today — today's challenge, empty until it is generated.
app.get('/today', (c) => {
  const userId = getCurrentUserId(c);
  const language = resolveLanguage(c.req.query('language'), userId);
  const day = getTodayDate(userId);
  return c.json({ day, items: dayItems(userId, language, day).map(toDto) });
});

// POST /api/recall/today — generate today's challenge, or return it when it exists.
app.post('/today', async (c) => {
  const userId = getCurrentUserId(c);
  const language = resolveLanguage(c.req.query('language'), userId);
  const day = getTodayDate(userId);
  const body = (await c.req.json().catch(() => ({}))) as { count?: unknown };
  const count = body.count ?? RECALL_DEFAULT_COUNT;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > RECALL_MAX_COUNT) {
    return c.json({ error: `count must be a whole number from 1 to ${RECALL_MAX_COUNT}` }, 400);
  }

  const key = `${userId}\0${language}\0${day}`;
  const inFlight = generating.get(key);
  if (inFlight) await inFlight.catch(() => {});
  if (dayItems(userId, language, day).length > 0) {
    return c.json({ day, items: dayItems(userId, language, day).map(toDto) });
  }

  const vocab = db
    .prepare(
      `SELECT id, text, state FROM vocab
        WHERE userId = ? AND language = ? AND type = 'word' AND state != 'ignored'`,
    )
    .all(userId, language) as RecallVocab[];
  if (vocab.length < RECALL_MIN_VOCAB) {
    return c.json(
      {
        error: `Save at least ${RECALL_MIN_VOCAB} words to your vocab to start recall practice.`,
        code: 'NOT_ENOUGH_VOCAB',
      },
      400,
    );
  }

  const verdict = entitlements.reserve(userId, 'llmRequestsPerMonth');
  if (!verdict.allowed) return planLimitResponse(c, verdict);
  let reservation: UsageReservation | null = verdict.reservation;

  const pack = getLanguageConfig(language);
  const avoid = (
    db
      .prepare(
        'SELECT english FROM recall_items WHERE userId = ? AND language = ? ORDER BY day DESC LIMIT ?',
      )
      .all(userId, language, AVOID_RECENT) as Array<{ english: string }>
  ).map((r) => r.english);

  const job = (async () => {
    const sentences = await buildRecallSentences(getProvider(userId, { byok: reservation!.byok }), {
      vocab,
      pack,
      count: count as number,
      avoid,
    });
    reservation = null;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO recall_items (userId, language, day, idx, english, reference, words)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      sentences.forEach((s, idx) =>
        insert.run(userId, language, day, idx, s.english, s.reference, JSON.stringify(s.words)),
      );
    })();
  })();
  generating.set(key, job);
  try {
    await job;
  } catch (error) {
    if (reservation) entitlements.refund(reservation);
    console.error('Recall generation error:', error);
    return c.json(
      { error: 'Could not write today’s sentences. Check the AI provider in Settings.' },
      502,
    );
  } finally {
    generating.delete(key);
  }

  const items = dayItems(userId, language, day);
  if (items.length === 0) {
    return c.json(
      {
        error: 'The AI could not write sentences from your vocab. Try again.',
        code: 'NO_SENTENCES',
      },
      502,
    );
  }
  return c.json({ day, items: items.map(toDto) });
});

function parseItemParams(day: string, idx: string): { day: string; idx: number } | null {
  const index = Number(idx);
  return DAY.test(day) && Number.isInteger(index) && index >= 0 ? { day, idx: index } : null;
}

// POST /api/recall/:day/:idx/answer — grade an answer; `giveUp` reveals it unanswered.
app.post('/:day/:idx/answer', async (c) => {
  const userId = getCurrentUserId(c);
  const language = resolveLanguage(c.req.query('language'), userId);
  const params = parseItemParams(c.req.param('day'), c.req.param('idx'));
  if (!params) return c.json({ error: 'Invalid day or index' }, 400);
  if (params.day !== getTodayDate(userId)) {
    return c.json({ error: 'This challenge has ended', code: 'EXPIRED' }, 409);
  }
  const row = getItem(userId, language, params.day, params.idx);
  if (!row) return c.json({ error: 'No such sentence' }, 404);
  if (row.answeredAt) return c.json({ error: 'Already answered', code: 'ANSWERED' }, 409);

  const body = (await c.req.json().catch(() => ({}))) as { answer?: unknown; giveUp?: unknown };
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (answer.length > MAX_ANSWER_LENGTH) {
    return c.json({ error: `answer must be at most ${MAX_ANSWER_LENGTH} characters` }, 400);
  }
  const giveUp = body.giveUp === true || answer === '';

  const pack = getLanguageConfig(language);
  const words = parseJson<RecallWord[]>(row.words, []);
  let grade: RecallGrade = { correct: false, corrected: '', notes: [], missed: [] };
  if (!giveUp) {
    const verdict = entitlements.reserve(userId, 'llmRequestsPerMonth');
    if (!verdict.allowed) return planLimitResponse(c, verdict);
    try {
      grade = await gradeRecallAnswer(getProvider(userId, { byok: verdict.reservation.byok }), {
        languageName: pack.name,
        english: row.english,
        reference: row.reference,
        answer,
        words: words.map((w) => w.text),
      });
    } catch (error) {
      entitlements.refund(verdict.reservation);
      console.error('Recall grading error:', error);
      return c.json(
        { error: 'Could not grade the answer. Check the AI provider in Settings.' },
        502,
      );
    }
  }

  const changes = vocabChangesFor(grade.correct, practisedVocab(userId, words), grade.missed, pack);
  const feedback: StoredFeedback = {
    corrected: grade.corrected,
    notes: grade.notes,
    missed: grade.missed,
  };
  const answered = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE recall_items
            SET answer = ?, correct = ?, aiCorrect = ?, feedback = ?, vocabChanges = ?, answeredAt = ?
          WHERE userId = ? AND language = ? AND day = ? AND idx = ? AND answeredAt IS NULL`,
      )
      .run(
        giveUp ? '' : answer,
        grade.correct ? 1 : 0,
        giveUp ? null : grade.correct ? 1 : 0,
        JSON.stringify(feedback),
        JSON.stringify(changes),
        new Date().toISOString(),
        userId,
        language,
        params.day,
        params.idx,
      );
    if (result.changes === 0) return false;
    applyChanges(userId, language, pack, changes);
    return true;
  })();
  if (!answered) return c.json({ error: 'Already answered', code: 'ANSWERED' }, 409);

  countPractice(userId, language, params.day);
  return c.json(toDto(getItem(userId, language, params.day, params.idx)!));
});

// PUT /api/recall/:day/:idx/verdict — override the grade; the level moves follow it.
app.put('/:day/:idx/verdict', async (c) => {
  const userId = getCurrentUserId(c);
  const language = resolveLanguage(c.req.query('language'), userId);
  const params = parseItemParams(c.req.param('day'), c.req.param('idx'));
  if (!params) return c.json({ error: 'Invalid day or index' }, 400);
  if (params.day !== getTodayDate(userId)) {
    return c.json({ error: 'This challenge has ended', code: 'EXPIRED' }, 409);
  }
  const body = (await c.req.json().catch(() => ({}))) as { correct?: unknown };
  if (typeof body.correct !== 'boolean') {
    return c.json({ error: 'correct must be true or false' }, 400);
  }
  const row = getItem(userId, language, params.day, params.idx);
  if (!row) return c.json({ error: 'No such sentence' }, 404);
  if (!row.answeredAt) return c.json({ error: 'Answer the sentence first' }, 409);

  const correct = body.correct;
  if ((row.correct === 1) !== correct) {
    const pack = getLanguageConfig(language);
    const feedback = parseJson<StoredFeedback | null>(row.feedback, null);
    db.transaction(() => {
      revertChanges(userId, language, pack, parseJson<VocabChange[]>(row.vocabChanges, []));
      const practised = practisedVocab(userId, parseJson<RecallWord[]>(row.words, []));
      const changes = vocabChangesFor(correct, practised, feedback?.missed ?? [], pack);
      applyChanges(userId, language, pack, changes);
      db.prepare(
        `UPDATE recall_items SET correct = ?, vocabChanges = ?
          WHERE userId = ? AND language = ? AND day = ? AND idx = ?`,
      ).run(correct ? 1 : 0, JSON.stringify(changes), userId, language, params.day, params.idx);
    })();
  }
  return c.json(toDto(getItem(userId, language, params.day, params.idx)!));
});

export default app;
