import { Hono } from 'hono';
import { db } from '../db';
import { resolveLanguage } from '../lib/active-language';
import { reserveDailyStatsRows } from '../lib/daily-stats-limits';
import { getTodayDate } from '../lib/dates';
import {
  buildFormsRound,
  candidateWords,
  FORMS_DEFAULT_COUNT,
  FORMS_KINDS,
  FORMS_MAX_COUNT,
  type FormsKind,
} from '../lib/forms-drill';
import { getLanguageConfig, supportsInflectionDrills } from '../lib/languages';
import { getCurrentUserId } from '../lib/user';

const app = new Hono();

// GET /api/forms/round?kinds=noun,verb&count=10 — base forms to inflect, with their tables.
app.get('/round', (c) => {
  const userId = getCurrentUserId(c);
  const language = resolveLanguage(c.req.query('language'), userId);
  const pack = getLanguageConfig(language);
  if (!supportsInflectionDrills(pack)) {
    return c.json({ error: `${pack.name} has no forms drill`, code: 'NOT_SUPPORTED' }, 400);
  }
  const kinds = (c.req.query('kinds') ?? 'noun,verb').split(',').filter(Boolean);
  if (kinds.length === 0 || !kinds.every((k) => (FORMS_KINDS as string[]).includes(k))) {
    return c.json({ error: 'kinds must list noun, verb or both' }, 400);
  }
  const count = Number(c.req.query('count') ?? FORMS_DEFAULT_COUNT);
  if (!Number.isInteger(count) || count < 1 || count > FORMS_MAX_COUNT) {
    return c.json({ error: `count must be a whole number from 1 to ${FORMS_MAX_COUNT}` }, 400);
  }

  const items = buildFormsRound({
    words: candidateWords(userId, language, Math.random),
    kinds: kinds as FormsKind[],
    count,
    pack,
  });
  if (items.length === 0) {
    return c.json(
      {
        error: `No ${kinds.join(' or ')} tables found. The forms drill needs the ${pack.name} dictionary.`,
        code: 'NO_ITEMS',
      },
      404,
    );
  }
  return c.json({ items });
});

// POST /api/forms/answer — count one answered item toward today's practice.
app.post('/answer', (c) => {
  const userId = getCurrentUserId(c);
  const language = resolveLanguage(c.req.query('language'), userId);
  const day = getTodayDate(userId);
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
  return c.json({ success: true });
});

export default app;
