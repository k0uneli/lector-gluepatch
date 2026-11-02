// Background podcast generator. Runs in the Hono process only, and only with
// PODCAST_WORKER=1, so it stays off under test and e2e. Each tick renders one
// paragraph of the oldest unfinished episode and commits it, so a restart
// resumes at the next paragraph.

import { db, type PodcastEpisodeRow } from '../../db';
import { packForLanguage } from '../active-language';
import { deleteAudioFile } from '../audio-files';
import { lookupWord } from '../dictionary-db';
import { entitlements, type LimitVerdict } from '../entitlements';
import type { LanguageConfig } from '../languages';
import { getProvider } from '../llm';
import type { KnownWord } from '../reading-challenge';
import { Sentry } from '../sentry';
import {
  appendEpisodeAudio,
  ffmpegToolkit,
  renderParagraph,
  type AudioToolkit,
  type RenderedParagraph,
} from './audio';
import { createPodcastVoice, PodcastLimitError, type PodcastVoice } from './engines';
import {
  assembleParagraph,
  describeEntry,
  EPISODE_OUTRO,
  episodeIntro,
  isTargetLine,
  knownForPodcast,
  planSentences,
  UnknownWordFinder,
  writeParagraphNotes,
  type ScriptLine,
  type ScriptNote,
  type SentencePlan,
} from './script';
import { readPodcastSettings, type PodcastEngineId, type PodcastSettings } from './settings';
import { episodeAudioPath } from './store';
import { paragraphSentences } from './text';

/** Attempts per paragraph, including the one being made. */
const MAX_ATTEMPTS = 3;
/** Wait after a failed attempt before the episode is tried again. */
const RETRY_DELAY_MS = 30_000;

export interface NotesRequest {
  languageName: string;
  sentences: readonly SentencePlan[];
  previous: string | null;
}

export interface PodcastWorkerDeps {
  settings(userId: string): PodcastSettings;
  writeNotes(userId: string, request: NotesRequest): Promise<ScriptNote[][]>;
  voice(
    userId: string,
    engine: PodcastEngineId,
    settings: PodcastSettings,
    pack: LanguageConfig,
  ): PodcastVoice;
  describe(userId: string, word: string, language: string): string | null;
  finder(known: readonly KnownWord[], pack: LanguageConfig): UnknownWordFinder;
  toolkit: AudioToolkit;
}

async function writeNotesWithProvider(userId: string, request: NotesRequest) {
  const verdict = entitlements.reserve(userId, 'llmRequestsPerMonth');
  if (!verdict.allowed) throw new PodcastLimitError('The monthly AI request limit is reached.');
  try {
    return await writeParagraphNotes(
      getProvider(userId, { byok: verdict.reservation.byok }),
      request,
    );
  } catch (err) {
    entitlements.refund(verdict.reservation);
    throw err;
  }
}

export const defaultWorkerDeps: PodcastWorkerDeps = {
  settings: readPodcastSettings,
  writeNotes: writeNotesWithProvider,
  voice: (userId, engine, settings, pack) => createPodcastVoice(userId, engine, settings, pack),
  describe: (userId, word, language) => describeEntry(lookupWord(userId, word, language)),
  finder: (known, pack) => new UnknownWordFinder(known, pack),
  toolkit: ffmpegToolkit(),
};

export type PodcastOutcome =
  | { state: 'idle' }
  | { state: 'progress'; episodeId: string; paragraph: number }
  | { state: 'done'; episodeId: string }
  | { state: 'retrying'; episodeId: string; error: string }
  | { state: 'failed'; episodeId: string; error: string }
  | { state: 'dropped'; episodeId: string };

class EpisodeGoneError extends Error {}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function selectNextEpisode(now = Date.now()): PodcastEpisodeRow | null {
  const retryAfter = new Date(now - RETRY_DELAY_MS).toISOString();
  return (
    (db
      .prepare(
        `SELECT * FROM podcast_episodes
          WHERE status IN ('pending', 'generating') AND (error IS NULL OR updatedAt <= ?)
          ORDER BY createdAt, id
          LIMIT 1`,
      )
      .get(retryAfter) as PodcastEpisodeRow | null) ?? null
  );
}

function markFailed(episode: PodcastEpisodeRow, message: string): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE podcast_episodes SET status = 'error', error = ?, updatedAt = ?
        WHERE userId = ? AND id = ?`,
    ).run(message.slice(0, 500), now, episode.userId, episode.id);
    db.prepare(
      "UPDATE lessons SET transcriptionStatus = 'done' WHERE userId = ? AND id = ? AND transcriptionStatus = 'generating'",
    ).run(episode.userId, episode.lessonId);
  })();
}

/** The spoken lines of the paragraph at `index` (0-based within the episode). */
async function scriptParagraph(
  episode: PodcastEpisodeRow,
  paragraphs: readonly string[],
  index: number,
  pack: LanguageConfig,
  settings: PodcastSettings,
  deps: PodcastWorkerDeps,
): Promise<{ lines: ScriptLine[]; explained: string[] }> {
  const known = db
    .prepare('SELECT word, state FROM knownWords WHERE userId = ? AND language = ?')
    .all(episode.userId, episode.language) as KnownWord[];
  const finder = deps.finder(knownForPodcast(known, settings.explainBelow), pack);
  const alreadyExplained = new Set(parseList(episode.explained));
  const sentences = paragraphSentences(paragraphs[index], pack);
  const plans = planSentences(sentences, finder, alreadyExplained, (word) =>
    deps.describe(episode.userId, word, episode.language),
  );
  const notes = await deps.writeNotes(episode.userId, {
    languageName: pack.name,
    sentences: plans,
    previous: index > 0 ? paragraphs[index - 1] : null,
  });
  const lines = assembleParagraph({
    number: episode.paraFrom + index,
    sentences,
    notes,
    intro:
      index === 0
        ? episodeIntro({
            pack,
            sourceTitle: episode.sourceTitle,
            bookTitle: episode.bookTitle,
            paraFrom: episode.paraFrom,
            paraTo: episode.paraTo,
            wholeChapter: episode.title === episode.sourceTitle,
          })
        : undefined,
    outro: index === paragraphs.length - 1 ? EPISODE_OUTRO : undefined,
  });
  const explained = [...alreadyExplained, ...plans.flatMap((p) => p.words.map((w) => w.word))];
  return { lines, explained };
}

/** Write the paragraph's audio, transcript and progress in one step. */
function commitParagraph(
  episode: PodcastEpisodeRow,
  index: number,
  total: number,
  lines: readonly ScriptLine[],
  rendered: RenderedParagraph,
  explained: readonly string[],
): void {
  const lesson = db
    .prepare(
      'SELECT audioPath, audioBytes, audioDurationMs FROM lessons WHERE id = ? AND userId = ?',
    )
    .get(episode.lessonId, episode.userId) as {
    audioPath: string | null;
    audioBytes: number | null;
    audioDurationMs: number | null;
  } | null;
  if (!lesson) throw new EpisodeGoneError();

  const audioPath = lesson.audioPath ?? episodeAudioPath(episode.lessonId);
  const committedBytes = lesson.audioPath ? (lesson.audioBytes ?? 0) : 0;
  const offsetMs = lesson.audioPath ? (lesson.audioDurationMs ?? 0) : 0;
  const audioBytes = appendEpisodeAudio(audioPath, committedBytes, rendered.mp3);
  const last = index === total - 1;
  const now = new Date().toISOString();

  const discardAppend = () => {
    const stillThere = db
      .prepare('SELECT 1 FROM lessons WHERE id = ? AND userId = ?')
      .get(episode.lessonId, episode.userId);
    if (stillThere) appendEpisodeAudio(audioPath, committedBytes, new Uint8Array());
    else deleteAudioFile(audioPath);
  };

  let verdict: LimitVerdict;
  try {
    verdict = entitlements.reserveCount(
      episode.userId,
      [{ metric: 'maxAudioStorageBytes', requested: rendered.mp3.byteLength }],
      () => {
        const advanced = db
          .prepare(
            `UPDATE podcast_episodes
              SET paraDone = ?, explained = ?, attempts = 0, error = NULL, status = ?,
                  updatedAt = ?, completedAt = ?
            WHERE userId = ? AND id = ? AND paraDone = ? AND status IN ('pending', 'generating')`,
          )
          .run(
            index + 1,
            JSON.stringify(explained),
            last ? 'done' : 'generating',
            now,
            last ? now : null,
            episode.userId,
            episode.id,
            index,
          ).changes;
        if (advanced === 0) throw new EpisodeGoneError();
        const { nextIdx } = db
          .prepare(
            'SELECT COALESCE(MAX(idx), -1) + 1 AS nextIdx FROM transcript_segments WHERE userId = ? AND lessonId = ?',
          )
          .get(episode.userId, episode.lessonId) as { nextIdx: number };
        const insert = db.prepare(
          `INSERT INTO transcript_segments (userId, lessonId, idx, startMs, endMs, text, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        rendered.cues.forEach((cue, i) => {
          const line = lines[cue.line];
          insert.run(
            episode.userId,
            episode.lessonId,
            nextIdx + i,
            offsetMs + cue.startMs,
            offsetMs + cue.endMs,
            line.text,
            isTargetLine(line) ? null : 'en',
          );
        });
        db.prepare(
          `UPDATE lessons SET audioPath = ?, audioBytes = ?, audioDurationMs = ?, transcriptionStatus = ?
          WHERE id = ? AND userId = ?`,
        ).run(
          audioPath,
          audioBytes,
          offsetMs + rendered.durationMs,
          last ? 'done' : 'generating',
          episode.lessonId,
          episode.userId,
        );
      },
    );
  } catch (err) {
    discardAppend();
    throw err;
  }
  if (!verdict.allowed) {
    discardAppend();
    throw new PodcastLimitError('The audio storage limit is reached.');
  }
}

/** One step: render and commit the next paragraph of the oldest unfinished episode. */
export async function processNextParagraph(
  deps: PodcastWorkerDeps = defaultWorkerDeps,
): Promise<PodcastOutcome> {
  const episode = selectNextEpisode();
  if (!episode) return { state: 'idle' };

  const lessonExists = db
    .prepare('SELECT 1 FROM lessons WHERE id = ? AND userId = ?')
    .get(episode.lessonId, episode.userId);
  if (!lessonExists) {
    db.prepare('DELETE FROM podcast_episodes WHERE userId = ? AND id = ?').run(
      episode.userId,
      episode.id,
    );
    return { state: 'dropped', episodeId: episode.id };
  }

  const paragraphs = parseList(episode.paragraphs);
  const index = episode.paraDone;
  if (index >= paragraphs.length) {
    db.prepare(
      "UPDATE podcast_episodes SET status = 'done', updatedAt = ? WHERE userId = ? AND id = ?",
    ).run(new Date().toISOString(), episode.userId, episode.id);
    return { state: 'done', episodeId: episode.id };
  }

  db.prepare(
    `UPDATE podcast_episodes SET status = 'generating', attempts = attempts + 1, updatedAt = ?
      WHERE userId = ? AND id = ?`,
  ).run(new Date().toISOString(), episode.userId, episode.id);
  const attempt = episode.attempts + 1;

  try {
    const pack = packForLanguage(episode.language);
    const settings = deps.settings(episode.userId);
    const { lines, explained } = await scriptParagraph(
      episode,
      paragraphs,
      index,
      pack,
      settings,
      deps,
    );
    const voice = deps.voice(episode.userId, episode.engine as PodcastEngineId, settings, pack);
    const rendered = await renderParagraph(
      lines,
      (run) => voice.speak(run.text, run.voice),
      deps.toolkit,
      { slowTempo: settings.slowTempo },
    );
    commitParagraph(episode, index, paragraphs.length, lines, rendered, explained);
    return index === paragraphs.length - 1
      ? { state: 'done', episodeId: episode.id }
      : { state: 'progress', episodeId: episode.id, paragraph: index + 1 };
  } catch (err) {
    if (err instanceof EpisodeGoneError) return { state: 'dropped', episodeId: episode.id };
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PodcastLimitError || attempt >= MAX_ATTEMPTS) {
      markFailed(episode, message);
      return { state: 'failed', episodeId: episode.id, error: message };
    }
    db.prepare(
      'UPDATE podcast_episodes SET error = ?, updatedAt = ? WHERE userId = ? AND id = ?',
    ).run(message.slice(0, 500), new Date().toISOString(), episode.userId, episode.id);
    return { state: 'retrying', episodeId: episode.id, error: message };
  }
}

export function podcastWorkerEnabled(): boolean {
  return process.env.PODCAST_WORKER === '1';
}

let loopTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await Sentry.startSpan({ name: 'podcast-worker.tick', op: 'queue.process' }, async () => {
      const outcome = await processNextParagraph();
      if (outcome.state === 'retrying') {
        console.warn(
          `[podcast-worker] episode ${outcome.episodeId} failed (${outcome.error}), will retry`,
        );
      } else if (outcome.state === 'failed') {
        console.warn(`[podcast-worker] episode ${outcome.episodeId} failed: ${outcome.error}`);
      } else if (outcome.state === 'done') {
        console.log(`[podcast-worker] episode ${outcome.episodeId} is done`);
      }
    });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[podcast-worker] tick failed:', err);
  } finally {
    ticking = false;
  }
}

/** Boot the loop (Hono process only). No-op unless PODCAST_WORKER=1. */
export function startPodcastWorker(): boolean {
  if (!podcastWorkerEnabled()) return false;
  if (loopTimer) return true;
  const intervalMs = Math.max(500, parseInt(process.env.PODCAST_INTERVAL_MS || '2000', 10) || 2000);
  loopTimer = setInterval(tick, intervalMs);
  loopTimer.unref?.();
  console.log(`[podcast-worker] enabled (every ${intervalMs}ms)`);
  return true;
}

/** Start the next paragraph now instead of at the next interval. */
export function kickPodcastWorker(): void {
  if (!loopTimer) return;
  setTimeout(tick, 0).unref?.();
}

export function stopPodcastWorker(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}
