import '../test-guard';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import { db } from '../db';
import { invalidateDictionaryCache } from '../lib/dictionary-db';
import { episodeAudioPath } from '../lib/podcast/store';
import lessons from './lessons';
import { makePodcastRoutes, MAX_EPISODE_PARAGRAPHS } from './podcasts';

const USER = 'local';
const app = makePodcastRoutes('selfhost');
const cloud = makePodcastRoutes('cloud');
const ENV_KEYS = [
  'PODCAST_TTS_URL',
  'PODCAST_TTS_VOICE',
  'PODCAST_TTS_ENGLISH_VOICE',
  'GOOGLE_CLOUD_API_KEY',
  'ELEVENLABS_API_KEY',
  'DICT_DIR',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(() => {
  // No dictionary: unknown words fall back to surface forms.
  process.env.DICT_DIR = fs.mkdtempSync('.test-data/podcast-dict-');
  invalidateDictionaryCache('ru');
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  invalidateDictionaryCache('ru');
});

const CHAPTER_1 = '# Глава 1\n\nКот видит дом. Дом большой.\n\nКот спит.\n\nСобака лает.';

function seedBook() {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO collections (id, title, author, coverUrl, language, createdAt, lastReadAt, userId)
     VALUES ('book-1', 'Книга', 'Автор', 'https://covers.test/k.jpg', 'ru', ?, ?, ?)`,
  ).run(now, now, USER);
  const insert = db.prepare(
    `INSERT INTO lessons (id, collectionId, title, sortOrder, textContent, language, createdAt, lastReadAt, userId)
     VALUES (?, ?, ?, ?, ?, 'ru', ?, ?, ?)`,
  );
  insert.run('chapter-1', 'book-1', 'Глава 1', 0, CHAPTER_1, now, now, USER);
  insert.run('chapter-2', 'book-1', 'Глава 2', 1, 'Утро.\n\nВечер.', now, now, USER);
  insert.run('loose', null, 'Заметка', 0, 'Просто текст.', now, now, USER);
}

beforeEach(() => {
  for (const table of [
    'podcast_episodes',
    'podcast_shows',
    'podcast_feed_tokens',
    'transcript_segments',
    'lessons',
    'collections',
    'knownWords',
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE userId = ?`).run(USER);
  }
  db.prepare("DELETE FROM podcast_shows WHERE userId = 'other'").run();
  process.env.PODCAST_TTS_URL = 'http://gpu.lan:8004';
  process.env.PODCAST_TTS_VOICE = 'ru';
  process.env.PODCAST_TTS_ENGLISH_VOICE = 'en';
  delete process.env.GOOGLE_CLOUD_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  seedBook();
});

const req = (target: typeof app, method: string, url: string, body?: unknown, headers = {}) =>
  target.request(`${url}${url.includes('?') ? '&' : '?'}language=ru`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

interface ListBody {
  workerEnabled: boolean;
  engines: Record<string, { configured: boolean; reason?: string }>;
  defaultEngine: string | null;
  feed: { available: boolean; hasToken: boolean };
  shows: Array<{
    id: string;
    collectionId: string;
    title: string;
    author: string;
    episodes: Array<{
      id: string;
      title: string;
      lessonId: string;
      status: string;
      paraTotal: number;
    }>;
  }>;
}

async function list(target = app): Promise<ListBody> {
  return (await req(target, 'GET', '/')).json() as Promise<ListBody>;
}

async function create(body: Record<string, unknown>) {
  const response = await req(app, 'POST', '/', { engine: 'local', ...body });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe('GET /api/podcasts', () => {
  test('reports the engines and an empty list', async () => {
    const body = await list();
    expect(body.shows).toEqual([]);
    expect(body.workerEnabled).toBe(false);
    expect(body.engines.local).toEqual({ configured: true });
    expect(body.engines.google).toEqual({
      configured: false,
      reason: 'Set GOOGLE_CLOUD_API_KEY on the server',
    });
    expect(body.engines.elevenlabs.configured).toBe(false);
    expect(body.defaultEngine).toBe('local');
    expect(body.feed).toEqual({ available: true, hasToken: false });
  });

  test('cloud offers only Google and no feed', async () => {
    const body = await list(cloud);
    expect(body.engines.local).toEqual({
      configured: false,
      reason: 'Available on self-hosted Lector only',
    });
    expect(body.feed.available).toBe(false);
    expect(body.defaultEngine).toBeNull();
  });
});

describe('POST /api/podcasts/estimate', () => {
  test('counts the paragraphs, sentences and words to explain', async () => {
    db.prepare(
      "INSERT INTO knownWords (userId, word, language, state) VALUES (?, 'кот', 'ru', 'known')",
    ).run(USER);
    const response = await req(app, 'POST', '/estimate', { lessonId: 'chapter-1', from: 1, to: 2 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).toMatchObject({
      paragraphCount: 3,
      from: 1,
      to: 2,
      paragraphs: 2,
      sentences: 3,
      unknownWords: 4,
      preview: { first: 'Кот видит дом. Дом большой.', last: 'Кот спит.' },
    });
    expect(body.minutes).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /api/podcasts', () => {
  test('validates the lesson, the range and the engine', async () => {
    expect((await create({})).status).toBe(400);
    expect((await create({ lessonId: 'missing' })).status).toBe(404);
    for (const range of [
      { from: 0, to: 2 },
      { from: 3, to: 2 },
      { from: 1, to: 4 },
      { from: 1.5, to: 2 },
      { from: '1', to: 2 },
    ]) {
      expect((await create({ lessonId: 'chapter-1', ...range })).status).toBe(400);
    }
    const google = await create({ lessonId: 'chapter-1', engine: 'google' });
    expect(google.status).toBe(400);
    expect(google.body.code).toBe('ENGINE_NOT_CONFIGURED');
    expect((await create({ lessonId: 'chapter-1', engine: 'piper' })).status).toBe(400);
  });

  test('refuses a lesson with no text and a podcast lesson as the source', async () => {
    db.prepare(
      "UPDATE lessons SET textContent = '## Только заголовок' WHERE id = 'chapter-2'",
    ).run();
    expect((await create({ lessonId: 'chapter-2' })).status).toBe(400);
    const { body } = await create({ lessonId: 'chapter-1' });
    expect((await create({ lessonId: body.episode.lessonId })).status).toBe(400);
  });

  test('caps the paragraphs of one episode', async () => {
    const long = Array.from({ length: MAX_EPISODE_PARAGRAPHS + 1 }, (_, i) => `Абзац ${i}.`).join(
      '\n\n',
    );
    db.prepare('UPDATE lessons SET textContent = ? WHERE id = ?').run(long, 'chapter-2');
    const tooMany = await create({ lessonId: 'chapter-2' });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toContain(`at most ${MAX_EPISODE_PARAGRAPHS}`);
    expect((await create({ lessonId: 'chapter-2', from: 2, to: 201 })).status).toBe(201);
  });

  test('puts a book’s episodes in one podcast collection, in chapter order', async () => {
    const later = await create({ lessonId: 'chapter-2' });
    const range = await create({ lessonId: 'chapter-1', from: 2, to: 3 });
    const whole = await create({ lessonId: 'chapter-1' });
    expect(later.status).toBe(201);
    expect(range.body.episode).toMatchObject({
      title: 'Глава 1 (¶2–3)',
      status: 'pending',
      paraDone: 0,
      paraTotal: 2,
    });

    const { shows } = await list();
    expect(shows).toHaveLength(1);
    expect(shows[0]).toMatchObject({ title: 'Книга · Podcast', author: 'Автор' });
    expect(shows[0].episodes.map((e) => e.title)).toEqual(['Глава 1', 'Глава 1 (¶2–3)', 'Глава 2']);

    const podcastLesson = db
      .prepare('SELECT * FROM lessons WHERE id = ?')
      .get(whole.body.episode.lessonId) as Record<string, any>;
    expect(podcastLesson).toMatchObject({
      collectionId: shows[0].collectionId,
      sourceType: 'podcast',
      transcriptionStatus: 'generating',
      audioPath: null,
      textContent: 'Кот видит дом. Дом большой.\n\nКот спит.\n\nСобака лает.',
    });
    expect(JSON.parse(podcastLesson.sourceMeta)).toEqual({
      episodeId: whole.body.episode.id,
      sourceLessonId: 'chapter-1',
    });
    const collection = db
      .prepare('SELECT coverUrl FROM collections WHERE id = ?')
      .get(shows[0].collectionId) as { coverUrl: string };
    expect(collection.coverUrl).toBe('https://covers.test/k.jpg');
  });

  test('puts lessons outside a collection in the shared Podcasts show', async () => {
    await create({ lessonId: 'loose' });
    const { shows } = await list();
    expect(shows.map((s) => s.title)).toEqual(['Podcasts']);
  });

  test('recreates a deleted podcast collection for the same show', async () => {
    await create({ lessonId: 'chapter-1' });
    const [before] = (await list()).shows;
    db.prepare('DELETE FROM lessons WHERE collectionId = ?').run(before.collectionId);
    db.prepare('DELETE FROM collections WHERE id = ?').run(before.collectionId);
    await create({ lessonId: 'chapter-2' });
    const [after] = (await list()).shows;
    expect(after.id).toBe(before.id);
    expect(after.collectionId).not.toBe(before.collectionId);
    expect(after.episodes.map((e) => e.title)).toEqual(['Глава 2']);
  });
});

describe('episode routes', () => {
  test('get, retry and delete an episode', async () => {
    const { body } = await create({ lessonId: 'chapter-1' });
    const id = body.episode.id as string;
    expect((await req(app, 'GET', `/${id}`)).status).toBe(200);
    expect((await req(app, 'GET', '/missing')).status).toBe(404);

    expect((await req(app, 'POST', `/${id}/retry`)).status).toBe(404);
    db.prepare(
      "UPDATE podcast_episodes SET status = 'error', error = 'x', attempts = 3 WHERE id = ?",
    ).run(id);
    db.prepare("UPDATE lessons SET transcriptionStatus = 'done' WHERE id = ?").run(
      body.episode.lessonId,
    );
    const retried = (await (await req(app, 'POST', `/${id}/retry`)).json()) as Record<string, any>;
    expect(retried.episode).toMatchObject({ status: 'generating', error: null });
    const lesson = db
      .prepare('SELECT transcriptionStatus FROM lessons WHERE id = ?')
      .get(body.episode.lessonId) as { transcriptionStatus: string };
    expect(lesson.transcriptionStatus).toBe('generating');

    expect((await req(app, 'DELETE', `/${id}`)).status).toBe(200);
    expect((await req(app, 'DELETE', `/${id}`)).status).toBe(404);
    expect(db.prepare('SELECT 1 FROM lessons WHERE id = ?').get(body.episode.lessonId)).toBeNull();
    expect((await list()).shows).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM collections WHERE id != 'book-1'").get()).toEqual({
      n: 0,
    });
  });

  test('deleting the lesson in the library forgets the episode', async () => {
    const { body } = await create({ lessonId: 'chapter-1' });
    const response = await lessons.request(`/${body.episode.lessonId}?language=ru`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(
      db.prepare('SELECT 1 FROM podcast_episodes WHERE id = ?').get(body.episode.id),
    ).toBeNull();
  });
});

describe('feed', () => {
  async function finishedEpisode() {
    const { body } = await create({ lessonId: 'chapter-1' });
    const audioPath = episodeAudioPath(body.episode.lessonId);
    fs.mkdirSync(audioPath.replace(/[^/]+$/, ''), { recursive: true });
    fs.writeFileSync(audioPath, new Uint8Array(4000).fill(7));
    db.prepare(
      `UPDATE lessons SET audioPath = ?, audioBytes = 4000, audioDurationMs = 500000,
              transcriptionStatus = 'done' WHERE id = ?`,
    ).run(audioPath, body.episode.lessonId);
    db.prepare(
      "UPDATE podcast_episodes SET status = 'done', completedAt = '2026-11-02T10:00:00.000Z' WHERE id = ?",
    ).run(body.episode.id);
    return body.episode as { id: string; showId: string };
  }

  async function newToken(): Promise<string> {
    const response = await req(app, 'POST', '/feed-token');
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  }

  test('serves an RSS feed of the finished episodes and their audio', async () => {
    const episode = await finishedEpisode();
    await create({ lessonId: 'chapter-2' });
    const token = await newToken();
    expect((await list()).feed.hasToken).toBe(true);

    const feed = await app.request(`/feed/${token}/${episode.showId}`, {
      headers: { host: 'lector.lan:3457' },
    });
    expect(feed.status).toBe(200);
    expect(feed.headers.get('Content-Type')).toContain('application/rss+xml');
    const xml = await feed.text();
    expect(xml).toContain('<title>Книга · Podcast</title>');
    expect(xml).toContain('<itunes:image href="https://covers.test/k.jpg"/>');
    expect(xml.match(/<item>/g)).toHaveLength(1);
    expect(xml).toContain(
      `<enclosure url="http://lector.lan:3457/api/podcasts/feed/${token}/${episode.showId}/${episode.id}.mp3" length="4000" type="audio/mpeg"/>`,
    );
    expect(xml).toContain('<itunes:duration>500</itunes:duration>');

    const audio = await app.request(`/feed/${token}/${episode.showId}/${episode.id}.mp3`, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(audio.status).toBe(206);
    expect((await audio.arrayBuffer()).byteLength).toBe(100);
  });

  test('a wrong, rotated or revoked token, or another account’s show, gives 404', async () => {
    const episode = await finishedEpisode();
    const first = await newToken();
    expect((await app.request(`/feed/wrong/${episode.showId}`)).status).toBe(404);
    const second = await newToken();
    expect((await app.request(`/feed/${first}/${episode.showId}`)).status).toBe(404);
    expect((await app.request(`/feed/${second}/${episode.showId}`)).status).toBe(200);

    db.prepare(
      `INSERT INTO podcast_shows (userId, id, language, sourceKey, collectionId, createdAt)
       VALUES ('other', 'other-show', 'ru', 'x', 'book-1', '2026-01-01')`,
    ).run();
    expect((await app.request(`/feed/${second}/other-show`)).status).toBe(404);
    expect((await app.request(`/feed/${second}/${episode.showId}/missing.mp3`)).status).toBe(404);

    expect((await req(app, 'DELETE', '/feed-token')).status).toBe(200);
    expect((await app.request(`/feed/${second}/${episode.showId}`)).status).toBe(404);
  });

  test('is not available in cloud mode', async () => {
    expect((await req(cloud, 'POST', '/feed-token')).status).toBe(404);
    expect((await cloud.request('/feed/token/show')).status).toBe(404);
  });
});
