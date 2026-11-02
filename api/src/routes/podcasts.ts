import { createHash, randomBytes } from 'crypto';
import { Hono, type Context } from 'hono';
import { db, type LessonRow, type PodcastEpisodeRow } from '../db';
import { resolveLanguage } from '../lib/active-language';
import { serveRangedFile } from '../lib/audio-files';
import { config, type LectorMode } from '../lib/config';
import { planLimitResponse } from '../lib/entitlements';
import { getLanguageConfig, type LanguageConfig } from '../lib/languages';
import { createPodcastVoice } from '../lib/podcast/engines';
import { knownForPodcast, UnknownWordFinder } from '../lib/podcast/script';
import {
  defaultEngine,
  engineStatuses,
  PODCAST_ENGINES,
  readPodcastSettings,
  type PodcastEngineId,
} from '../lib/podcast/settings';
import { createEpisode, deleteEpisode, getEpisode } from '../lib/podcast/store';
import { paragraphSentences, podcastParagraphs } from '../lib/podcast/text';
import { kickPodcastWorker, podcastWorkerEnabled } from '../lib/podcast/worker';
import type { KnownWord } from '../lib/reading-challenge';
import { getCurrentUserId } from '../lib/user';

/** Longer chapters need a paragraph range. */
export const MAX_EPISODE_PARAGRAPHS = 200;
/** Rough spoken length of the script per explained word, per sentence and per paragraph. */
const CHARS_PER_EXPLAINED_WORD = 140;
const CHARS_PER_SENTENCE_NOTE = 60;
const CHARS_PER_PARAGRAPH = 60;
/** Narration with pauses runs at about this many characters per minute. */
const CHARS_PER_MINUTE = 750;

interface EpisodeListRow extends PodcastEpisodeRow {
  audioDurationMs: number | null;
  audioBytes: number | null;
  sortOrder: number;
}

function toEpisodeDto(row: EpisodeListRow) {
  return {
    id: row.id,
    showId: row.showId,
    lessonId: row.lessonId,
    sourceLessonId: row.sourceLessonId,
    title: row.title,
    paraFrom: row.paraFrom,
    paraTo: row.paraTo,
    paraDone: row.paraDone,
    paraTotal: row.paraTo - row.paraFrom + 1,
    status: row.status,
    error: row.error,
    engine: row.engine,
    durationMs: row.audioDurationMs ?? 0,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

const EPISODE_SELECT = `SELECT e.*, l.audioDurationMs, l.audioBytes, l.sortOrder
   FROM podcast_episodes e
   JOIN lessons l ON l.id = e.lessonId AND l.userId = e.userId`;

function episodeDto(userId: string, id: string) {
  const row = db
    .prepare(`${EPISODE_SELECT} WHERE e.userId = ? AND e.id = ?`)
    .get(userId, id) as EpisodeListRow | null;
  return row ? toEpisodeDto(row) : null;
}

interface ShowListRow {
  id: string;
  collectionId: string;
  title: string;
  author: string;
  coverUrl: string | null;
}

function listShows(userId: string, language: string) {
  const shows = db
    .prepare(
      `SELECT s.id, s.collectionId, c.title, c.author, c.coverUrl
         FROM podcast_shows s
         JOIN collections c ON c.id = s.collectionId AND c.userId = s.userId
        WHERE s.userId = ? AND s.language = ?
        ORDER BY c.lastReadAt DESC`,
    )
    .all(userId, language) as ShowListRow[];
  const episodesOf = db.prepare(
    `${EPISODE_SELECT} WHERE e.userId = ? AND e.showId = ? ORDER BY l.sortOrder, e.createdAt`,
  );
  return shows
    .map((show) => ({
      ...show,
      episodes: (episodesOf.all(userId, show.id) as EpisodeListRow[]).map(toEpisodeDto),
    }))
    .filter((show) => show.episodes.length > 0);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function feedUser(token: string): string | null {
  const row = db
    .prepare('SELECT userId FROM podcast_feed_tokens WHERE tokenHash = ?')
    .get(hashToken(token)) as { userId: string } | null;
  return row?.userId ?? null;
}

function requestOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto =
    c.req.header('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.slice(0, -1);
  const host =
    c.req.header('x-forwarded-host')?.split(',')[0].trim() || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface SourceRange {
  lesson: LessonRow;
  paragraphs: string[];
  from: number;
  to: number;
}

/** The lesson and the paragraph range a request names, or an error message. */
function resolveRange(
  userId: string,
  language: string,
  body: { lessonId?: unknown; from?: unknown; to?: unknown },
): SourceRange | { error: string; status: 400 | 404 } {
  if (typeof body.lessonId !== 'string' || !body.lessonId) {
    return { error: 'lessonId is required', status: 400 };
  }
  const lesson = db
    .prepare('SELECT * FROM lessons WHERE id = ? AND userId = ? AND language = ?')
    .get(body.lessonId, userId, language) as LessonRow | null;
  if (!lesson) return { error: 'Lesson not found', status: 404 };
  if (lesson.sourceType === 'podcast') {
    return { error: 'A podcast episode cannot be the source of another episode', status: 400 };
  }
  const paragraphs = podcastParagraphs(lesson.textContent);
  if (paragraphs.length === 0) return { error: 'This lesson has no text to read', status: 400 };
  const from = body.from ?? 1;
  const to = body.to ?? paragraphs.length;
  if (
    typeof from !== 'number' ||
    typeof to !== 'number' ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to > paragraphs.length ||
    from > to
  ) {
    return {
      error: `from and to must be whole paragraph numbers with 1 ≤ from ≤ to ≤ ${paragraphs.length}`,
      status: 400,
    };
  }
  if (to - from + 1 > MAX_EPISODE_PARAGRAPHS) {
    return {
      error: `An episode can hold at most ${MAX_EPISODE_PARAGRAPHS} paragraphs. Choose a smaller range.`,
      status: 400,
    };
  }
  return { lesson, paragraphs, from, to };
}

function estimate(userId: string, pack: LanguageConfig, range: SourceRange) {
  const settings = readPodcastSettings(userId);
  const known = db
    .prepare('SELECT word, state FROM knownWords WHERE userId = ? AND language = ?')
    .all(userId, pack.code) as KnownWord[];
  const finder = new UnknownWordFinder(knownForPodcast(known, settings.explainBelow), pack);
  const selected = range.paragraphs.slice(range.from - 1, range.to);
  const unknown = new Set<string>();
  let sentences = 0;
  let characters = 0;
  for (const paragraph of selected) {
    const parts = paragraphSentences(paragraph, pack);
    sentences += parts.length;
    characters += CHARS_PER_PARAGRAPH;
    for (const sentence of parts) {
      characters += sentence.length * (parts.length > 1 ? 2 : 1) + CHARS_PER_SENTENCE_NOTE;
      for (const word of finder.find(sentence)) {
        if (unknown.has(word)) continue;
        unknown.add(word);
        characters += CHARS_PER_EXPLAINED_WORD;
      }
    }
  }
  return {
    paragraphCount: range.paragraphs.length,
    from: range.from,
    to: range.to,
    paragraphs: selected.length,
    sentences,
    unknownWords: unknown.size,
    characters,
    minutes: Math.max(1, Math.round(characters / CHARS_PER_MINUTE)),
    preview: { first: selected[0], last: selected[selected.length - 1] },
  };
}

export function makePodcastRoutes(mode: LectorMode = config.mode): Hono {
  const app = new Hono();
  const selfhostOnly = (c: Context) =>
    mode === 'selfhost' ? null : c.json({ error: 'Not found' }, 404);

  // GET /api/podcasts — the shows of the active language, with their episodes.
  app.get('/', (c) => {
    const userId = getCurrentUserId(c);
    const language = resolveLanguage(c.req.query('language'), userId);
    const pack = getLanguageConfig(language);
    const settings = readPodcastSettings(userId);
    const engines = engineStatuses(settings, pack, mode);
    const hasFeedToken = !!db
      .prepare('SELECT 1 FROM podcast_feed_tokens WHERE userId = ?')
      .get(userId);
    return c.json({
      workerEnabled: podcastWorkerEnabled(),
      engines,
      defaultEngine: defaultEngine(settings, engines),
      feed: { available: mode === 'selfhost', hasToken: hasFeedToken },
      shows: listShows(userId, language),
    });
  });

  // POST /api/podcasts/estimate — what an episode of this range would hold.
  app.post('/estimate', async (c) => {
    const userId = getCurrentUserId(c);
    const language = resolveLanguage(c.req.query('language'), userId);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const range = resolveRange(userId, language, body);
    if ('error' in range) return c.json({ error: range.error }, range.status);
    return c.json(estimate(userId, getLanguageConfig(language), range));
  });

  // POST /api/podcasts — queue a new episode.
  app.post('/', async (c) => {
    const userId = getCurrentUserId(c);
    const language = resolveLanguage(c.req.query('language'), userId);
    const pack = getLanguageConfig(language);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const range = resolveRange(userId, language, body);
    if ('error' in range) return c.json({ error: range.error }, range.status);

    const settings = readPodcastSettings(userId);
    const engines = engineStatuses(settings, pack, mode);
    const requested = body.engine ?? defaultEngine(settings, engines);
    if (
      typeof requested !== 'string' ||
      !(PODCAST_ENGINES as readonly string[]).includes(requested)
    ) {
      return c.json({ error: 'No voice engine is set up', code: 'ENGINE_NOT_CONFIGURED' }, 400);
    }
    const engine = requested as PodcastEngineId;
    if (!engines[engine].configured) {
      return c.json(
        {
          error: engines[engine].reason ?? 'This voice engine is not set up',
          code: 'ENGINE_NOT_CONFIGURED',
        },
        400,
      );
    }

    const collection = range.lesson.collectionId
      ? ((db
          .prepare(
            'SELECT id, title, author, coverUrl FROM collections WHERE id = ? AND userId = ?',
          )
          .get(range.lesson.collectionId, userId) as {
          id: string;
          title: string;
          author: string;
          coverUrl: string | null;
        } | null) ?? null)
      : null;
    const result = createEpisode(userId, {
      source: { ...range.lesson, language },
      collection,
      pack,
      paraFrom: range.from,
      paraTo: range.to,
      paragraphCount: range.paragraphs.length,
      paragraphs: range.paragraphs.slice(range.from - 1, range.to),
      engine,
    });
    if (!result.allowed) return planLimitResponse(c, result);
    kickPodcastWorker();
    return c.json({ episode: episodeDto(userId, result.episode.id) }, 201);
  });

  // POST /api/podcasts/engines/test — a short sample from both voices of an engine.
  app.post('/engines/test', async (c) => {
    const userId = getCurrentUserId(c);
    const language = resolveLanguage(c.req.query('language'), userId);
    const pack = getLanguageConfig(language);
    const body = (await c.req.json().catch(() => ({}))) as { engine?: unknown };
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
    const voice = createPodcastVoice(userId, engine, settings, pack);
    try {
      const english = await voice.speak('This is the English voice of your podcast.', 'en');
      const target = await voice.speak(pack.testPhrase, 'target');
      return c.json({
        samples: [
          {
            voice: 'en',
            contentType: 'audio/mpeg',
            audioContent: Buffer.from(english).toString('base64'),
          },
          {
            voice: 'target',
            contentType: 'audio/mpeg',
            audioContent: Buffer.from(target).toString('base64'),
          },
        ],
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'The voice engine failed' }, 502);
    }
  });

  // POST /api/podcasts/feed-token — create or replace the private feed token.
  app.post('/feed-token', (c) => {
    const blocked = selfhostOnly(c);
    if (blocked) return blocked;
    const userId = getCurrentUserId(c);
    const token = randomBytes(24).toString('base64url');
    db.prepare(
      `INSERT INTO podcast_feed_tokens (userId, tokenHash, createdAt) VALUES (?, ?, ?)
       ON CONFLICT (userId) DO UPDATE SET tokenHash = excluded.tokenHash, createdAt = excluded.createdAt`,
    ).run(userId, hashToken(token), new Date().toISOString());
    return c.json({ token }, 201);
  });

  // DELETE /api/podcasts/feed-token — close every feed of the account.
  app.delete('/feed-token', (c) => {
    const blocked = selfhostOnly(c);
    if (blocked) return blocked;
    const userId = getCurrentUserId(c);
    db.prepare('DELETE FROM podcast_feed_tokens WHERE userId = ?').run(userId);
    return c.json({ success: true });
  });

  // GET /api/podcasts/feed/:token/:showId — the RSS feed of one show.
  app.get('/feed/:token/:showId', (c) => {
    const blocked = selfhostOnly(c);
    if (blocked) return blocked;
    const userId = feedUser(c.req.param('token'));
    if (!userId) return c.json({ error: 'Not found' }, 404);
    const show = db
      .prepare(
        `SELECT s.id, s.language, c.title, c.author, c.coverUrl
           FROM podcast_shows s
           JOIN collections c ON c.id = s.collectionId AND c.userId = s.userId
          WHERE s.userId = ? AND s.id = ?`,
      )
      .get(userId, c.req.param('showId')) as {
      id: string;
      language: string;
      title: string;
      author: string;
      coverUrl: string | null;
    } | null;
    if (!show) return c.json({ error: 'Not found' }, 404);
    const episodes = db
      .prepare(
        `${EPISODE_SELECT}
          WHERE e.userId = ? AND e.showId = ? AND e.status = 'done' AND l.audioPath IS NOT NULL
          ORDER BY l.sortOrder, e.createdAt`,
      )
      .all(userId, show.id) as EpisodeListRow[];
    const base = `${requestOrigin(c)}/api/podcasts/feed/${encodeURIComponent(c.req.param('token'))}/${show.id}`;
    const cover =
      show.coverUrl && /^https?:\/\//.test(show.coverUrl)
        ? `\n    <itunes:image href="${xml(show.coverUrl)}"/>`
        : '';
    const items = episodes
      .map(
        (episode, i) => `
    <item>
      <title>${xml(episode.title)}</title>
      <guid isPermaLink="false">${episode.id}</guid>
      <pubDate>${new Date(episode.completedAt ?? episode.createdAt).toUTCString()}</pubDate>
      <enclosure url="${xml(`${base}/${episode.id}.mp3`)}" length="${episode.audioBytes ?? 0}" type="audio/mpeg"/>
      <itunes:duration>${Math.round((episode.audioDurationMs ?? 0) / 1000)}</itunes:duration>
      <itunes:episode>${i + 1}</itunes:episode>
    </item>`,
      )
      .join('');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${xml(show.title)}</title>
    <description>Slow-reading episodes generated by Lector.</description>
    <language>${xml(show.language)}</language>
    <itunes:author>${xml(show.author)}</itunes:author>
    <itunes:type>serial</itunes:type>${cover}${items}
  </channel>
</rss>
`;
    return c.body(body, 200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
  });

  // GET /api/podcasts/feed/:token/:showId/:file — one episode's audio, `<episodeId>.mp3`.
  app.get('/feed/:token/:showId/:file', async (c) => {
    const blocked = selfhostOnly(c);
    if (blocked) return blocked;
    const userId = feedUser(c.req.param('token'));
    const episodeId = c.req.param('file').replace(/\.mp3$/, '');
    if (!userId) return c.json({ error: 'Not found' }, 404);
    const row = db
      .prepare(
        `SELECT l.audioPath FROM podcast_episodes e
           JOIN lessons l ON l.id = e.lessonId AND l.userId = e.userId
          WHERE e.userId = ? AND e.id = ? AND e.showId = ? AND e.status = 'done'`,
      )
      .get(userId, episodeId, c.req.param('showId')) as { audioPath: string | null } | null;
    if (!row?.audioPath) return c.json({ error: 'Not found' }, 404);
    const file = Bun.file(row.audioPath);
    if (!(await file.exists())) return c.json({ error: 'Not found' }, 404);
    return serveRangedFile(file, 'audio/mpeg', c.req.header('range'));
  });

  // GET /api/podcasts/:id
  app.get('/:id', (c) => {
    const userId = getCurrentUserId(c);
    const episode = episodeDto(userId, c.req.param('id'));
    if (!episode) return c.json({ error: 'Episode not found' }, 404);
    return c.json({ episode });
  });

  // POST /api/podcasts/:id/retry — resume a failed episode at the paragraph that failed.
  app.post('/:id/retry', (c) => {
    const userId = getCurrentUserId(c);
    const episode = getEpisode(userId, c.req.param('id'));
    if (!episode || episode.status !== 'error') {
      return c.json({ error: 'Episode has no failed generation to retry' }, 404);
    }
    db.transaction(() => {
      db.prepare(
        `UPDATE podcast_episodes SET status = 'generating', attempts = 0, error = NULL, updatedAt = ?
          WHERE userId = ? AND id = ?`,
      ).run(new Date().toISOString(), userId, episode.id);
      db.prepare(
        "UPDATE lessons SET transcriptionStatus = 'generating' WHERE id = ? AND userId = ?",
      ).run(episode.lessonId, userId);
    })();
    kickPodcastWorker();
    return c.json({ episode: episodeDto(userId, episode.id) });
  });

  // DELETE /api/podcasts/:id — the episode with its lesson and audio.
  app.delete('/:id', (c) => {
    const userId = getCurrentUserId(c);
    if (!deleteEpisode(userId, c.req.param('id'))) {
      return c.json({ error: 'Episode not found' }, 404);
    }
    return c.json({ success: true });
  });

  return app;
}

export default makePodcastRoutes();
