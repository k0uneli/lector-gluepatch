import { randomUUID } from 'crypto';
import { db, type PodcastEpisodeRow, type PodcastShowRow } from '../../db';
import { audioPathForLesson, deleteAudioFile } from '../audio-files';
import { entitlements, type LimitVerdict } from '../entitlements';
import { buildSegmentWords, countWords } from '../html-to-markdown';
import type { LanguageConfig } from '../languages';
import {
  aggregateGrowthCheck,
  collectionMetadataBytes,
  growingRowCheck,
  lessonTextBytes,
} from '../storage-limits';
import type { PodcastEngineId } from './settings';

export const STANDALONE_SHOW_TITLE = 'Podcasts';
export const SHOW_TITLE_SUFFIX = ' · Podcast';
/** Episode sortOrder is chapter × stride + first paragraph, so episodes sort by chapter, then range. */
const SORT_STRIDE = 10_000;

export function podcastSortOrder(sourceSortOrder: number, paraFrom: number): number {
  return sourceSortOrder * SORT_STRIDE + paraFrom;
}

export function episodeTitle(
  chapterTitle: string,
  from: number,
  to: number,
  total: number,
): string {
  return from === 1 && to === total ? chapterTitle : `${chapterTitle} (¶${from}–${to})`;
}

export interface SourceLesson {
  id: string;
  collectionId: string | null;
  title: string;
  sortOrder: number;
  language: string;
}

export interface SourceCollection {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
}

function liveShow(userId: string, sourceKey: string): PodcastShowRow | null {
  const show = db
    .prepare('SELECT * FROM podcast_shows WHERE userId = ? AND sourceKey = ?')
    .get(userId, sourceKey) as PodcastShowRow | null;
  if (!show) return null;
  const exists = db
    .prepare('SELECT 1 FROM collections WHERE id = ? AND userId = ?')
    .get(show.collectionId, userId);
  return exists ? show : null;
}

export type CreateEpisodeResult =
  | { allowed: true; episode: PodcastEpisodeRow }
  | Exclude<LimitVerdict, { allowed: true }>;

/**
 * Create the episode, its lesson and, when the book has none yet, its podcast
 * collection. The lesson gains audio paragraph by paragraph in the worker.
 */
export function createEpisode(
  userId: string,
  opts: {
    source: SourceLesson;
    collection: SourceCollection | null;
    pack: LanguageConfig;
    paraFrom: number;
    paraTo: number;
    paragraphCount: number;
    paragraphs: string[];
    engine: PodcastEngineId;
  },
): CreateEpisodeResult {
  const { source, collection, pack } = opts;
  const now = new Date().toISOString();
  const sourceKey = collection ? collection.id : `standalone:${source.language}`;
  const show = liveShow(userId, sourceKey);
  const showId = show?.id ?? randomUUID();
  const collectionId = show?.collectionId ?? randomUUID();
  const showCollection = {
    title: collection ? `${collection.title}${SHOW_TITLE_SUFFIX}` : STANDALONE_SHOW_TITLE,
    author: collection?.author ?? 'Lector',
    coverUrl: collection?.coverUrl ?? null,
  };

  const lessonId = randomUUID();
  const episodeId = randomUUID();
  const title = episodeTitle(source.title, opts.paraFrom, opts.paraTo, opts.paragraphCount);
  const textContent = opts.paragraphs.join('\n\n');
  const textBytes = lessonTextBytes(textContent, title);
  const sourceMeta = JSON.stringify({ episodeId, sourceLessonId: source.id });

  const verdict = entitlements.reserveCount(
    userId,
    [
      ...(show
        ? []
        : [
            { metric: 'maxCollections' as const },
            ...growingRowCheck(
              'maxCollectionMetadataBytes',
              collectionMetadataBytes(showCollection),
            ),
          ]),
      { metric: 'maxLessons' },
      ...growingRowCheck('maxLessonTextBytes', textBytes),
      ...aggregateGrowthCheck('maxLessonTextBytesTotal', textBytes),
    ],
    () => {
      if (!show) {
        db.prepare(
          `INSERT INTO collections (id, title, author, coverUrl, groupId, language, createdAt, lastReadAt, userId)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        ).run(
          collectionId,
          showCollection.title,
          showCollection.author,
          showCollection.coverUrl,
          source.language,
          now,
          now,
          userId,
        );
        db.prepare(
          `INSERT INTO podcast_shows (userId, id, language, sourceKey, collectionId, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (userId, sourceKey) DO UPDATE SET collectionId = excluded.collectionId`,
        ).run(userId, showId, source.language, sourceKey, collectionId, now);
      }
      const resolvedShowId = (
        db
          .prepare('SELECT id FROM podcast_shows WHERE userId = ? AND sourceKey = ?')
          .get(userId, sourceKey) as { id: string }
      ).id;
      db.prepare(
        `INSERT INTO lessons (id, collectionId, title, sortOrder, textContent, wordCount, segmentWords,
                              language, createdAt, lastReadAt, userId, sourceType, sourceMeta,
                              transcriptionStatus)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'podcast', ?, 'generating')`,
      ).run(
        lessonId,
        collectionId,
        title,
        podcastSortOrder(source.sortOrder, opts.paraFrom),
        textContent,
        countWords(textContent, pack),
        buildSegmentWords(textContent, pack),
        source.language,
        now,
        now,
        userId,
        sourceMeta,
      );
      db.prepare(
        `INSERT INTO podcast_episodes (userId, id, showId, language, sourceLessonId, lessonId, title,
                                       sourceTitle, bookTitle, paraFrom, paraTo, paragraphs, engine,
                                       status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        userId,
        episodeId,
        resolvedShowId,
        source.language,
        source.id,
        lessonId,
        title,
        source.title,
        collection?.title ?? null,
        opts.paraFrom,
        opts.paraTo,
        JSON.stringify(opts.paragraphs),
        opts.engine,
        now,
        now,
      );
      db.prepare('UPDATE collections SET lastReadAt = ? WHERE id = ? AND userId = ?').run(
        now,
        collectionId,
        userId,
      );
    },
  );
  if (!verdict.allowed) return verdict;
  return { allowed: true, episode: getEpisode(userId, episodeId)! };
}

export function getEpisode(userId: string, id: string): PodcastEpisodeRow | null {
  return (
    (db
      .prepare('SELECT * FROM podcast_episodes WHERE userId = ? AND id = ?')
      .get(userId, id) as PodcastEpisodeRow | null) ?? null
  );
}

/**
 * Drop podcast rows whose lessons are being deleted. The caller deletes the
 * lessons and their audio; a show whose collection is gone is removed too.
 */
export function forgetPodcastLessons(userId: string, lessonIds: readonly string[]): void {
  if (lessonIds.length === 0) return;
  const placeholders = lessonIds.map(() => '?').join(', ');
  db.prepare(`DELETE FROM podcast_episodes WHERE userId = ? AND lessonId IN (${placeholders})`).run(
    userId,
    ...lessonIds,
  );
}

export function forgetPodcastCollection(userId: string, collectionId: string): void {
  db.prepare('DELETE FROM podcast_shows WHERE userId = ? AND collectionId = ?').run(
    userId,
    collectionId,
  );
}

/**
 * Delete an episode with its lesson, transcript and audio. The show and its
 * collection go too when this was their last episode.
 */
export function deleteEpisode(userId: string, id: string): boolean {
  let audioPath: string | null = null;
  let deleted = false;
  db.transaction(() => {
    const episode = getEpisode(userId, id);
    if (!episode) return;
    deleted = true;
    const lesson = db
      .prepare('SELECT audioPath, collectionId FROM lessons WHERE id = ? AND userId = ?')
      .get(episode.lessonId, userId) as {
      audioPath: string | null;
      collectionId: string | null;
    } | null;
    audioPath = lesson?.audioPath ?? null;
    db.prepare('UPDATE vocab SET bookId = NULL WHERE bookId = ? AND userId = ?').run(
      episode.lessonId,
      userId,
    );
    db.prepare('DELETE FROM transcript_segments WHERE userId = ? AND lessonId = ?').run(
      userId,
      episode.lessonId,
    );
    db.prepare('DELETE FROM lessons WHERE id = ? AND userId = ?').run(episode.lessonId, userId);
    db.prepare('DELETE FROM podcast_episodes WHERE userId = ? AND id = ?').run(userId, id);

    const collectionId = lesson?.collectionId;
    if (!collectionId) return;
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM lessons WHERE collectionId = ? AND userId = ?')
      .get(collectionId, userId) as { n: number };
    if (remaining.n > 0) return;
    db.prepare('DELETE FROM collections WHERE id = ? AND userId = ?').run(collectionId, userId);
    forgetPodcastCollection(userId, collectionId);
  })();
  deleteAudioFile(audioPath);
  return deleted;
}

export function episodeAudioPath(lessonId: string): string {
  return audioPathForLesson(lessonId, '.mp3');
}
