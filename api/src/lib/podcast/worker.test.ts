import '../../test-guard';
import { beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import { db, type PodcastEpisodeRow } from '../../db';
import { getLanguageConfig } from '../languages';
import { SAMPLE_RATE, type AudioToolkit } from './audio';
import { PodcastLimitError } from './engines';
import { UnknownWordFinder, type ParagraphScript } from './script';
import type { PodcastSettings } from './settings';
import { createEpisode, deleteEpisode } from './store';
import { processNextParagraph, type NotesRequest, type PodcastWorkerDeps } from './worker';

const USER = 'local';
const ru = getLanguageConfig('ru');
const PARAGRAPHS = ['Кот видит дом. Дом большой.', 'Кот спит.'];

const settings: PodcastSettings = {
  engine: 'local',
  googlePersona: '',
  localUrl: 'http://gpu.lan',
  localModel: '',
  localVoice: 'ru',
  localEnglishVoice: 'en',
  localApiKey: '',
  elevenApiKey: '',
  elevenVoiceId: '',
  elevenModel: '',
  slowTempo: 0.5,
  explainBelow: 'level3',
};

const toolkit: AudioToolkit = {
  async decode(audio, tempo) {
    const ms = (audio.byteLength * 10) / tempo;
    return new Uint8Array(Math.round((ms * SAMPLE_RATE) / 1000) * 2);
  },
  async encode(pcm) {
    return new Uint8Array(Math.floor(pcm.byteLength / 6));
  },
};

let requests: NotesRequest[] = [];
let writeNotes: PodcastWorkerDeps['writeNotes'];

const deps: PodcastWorkerDeps = {
  settings: () => settings,
  writeNotes: (userId, request) => writeNotes(userId, request),
  voice: () => ({ speak: async (text) => new Uint8Array(text.length) }),
  describe: (_userId, word) => `gloss of ${word}`,
  finder: (known, pack) => new UnknownWordFinder(known, pack, () => null),
  toolkit,
};

function notesFor(request: NotesRequest): ParagraphScript {
  return {
    notes: request.sentences.map((s) =>
      s.words.length > 0 ? [{ kind: 'word', say: `«${s.words[0].word}» is explained.` }] : [],
    ),
    translation: request.sentences.length > 1 ? 'The cat sees a house. The house is big.' : null,
  };
}

function episode(): PodcastEpisodeRow {
  return db
    .prepare('SELECT * FROM podcast_episodes WHERE userId = ?')
    .get(USER) as PodcastEpisodeRow;
}

function lesson(id: string) {
  return db.prepare('SELECT * FROM lessons WHERE id = ? AND userId = ?').get(id, USER) as {
    audioPath: string | null;
    audioBytes: number | null;
    audioDurationMs: number | null;
    transcriptionStatus: string | null;
  } | null;
}

function segments(lessonId: string) {
  return db
    .prepare(
      'SELECT idx, startMs, endMs, text, lang FROM transcript_segments WHERE userId = ? AND lessonId = ? ORDER BY idx',
    )
    .all(USER, lessonId) as Array<{
    idx: number;
    startMs: number;
    endMs: number;
    text: string;
    lang: string | null;
  }>;
}

function queueEpisode(paragraphs = PARAGRAPHS) {
  const result = createEpisode(USER, {
    source: {
      id: 'chapter-1',
      collectionId: 'book-1',
      title: 'Глава',
      sortOrder: 2,
      language: 'ru',
    },
    collection: { id: 'book-1', title: 'Книга', author: 'Автор', coverUrl: null },
    pack: ru,
    paraFrom: 1,
    paraTo: paragraphs.length,
    paragraphCount: paragraphs.length,
    paragraphs,
    engine: 'local',
  });
  if (!result.allowed) throw new Error('episode was not allowed');
  return result.episode;
}

beforeEach(() => {
  for (const table of [
    'podcast_episodes',
    'podcast_shows',
    'transcript_segments',
    'lessons',
    'collections',
    'knownWords',
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE userId = ?`).run(USER);
  }
  db.prepare(
    `INSERT INTO knownWords (userId, word, language, state) VALUES (?, 'дом', 'ru', 'known'), (?, 'видит', 'ru', 'level1')`,
  ).run(USER, USER);
  requests = [];
  writeNotes = async (_userId, request) => {
    requests.push(request);
    return notesFor(request);
  };
});

describe('processNextParagraph', () => {
  test('is idle without work', async () => {
    expect(await processNextParagraph(deps)).toEqual({ state: 'idle' });
  });

  test('adds one paragraph per step to the lesson audio and transcript', async () => {
    const queued = queueEpisode();

    const first = await processNextParagraph(deps);
    expect(first).toEqual({ state: 'progress', episodeId: queued.id, paragraph: 1 });
    const afterFirst = lesson(queued.lessonId)!;
    expect(afterFirst.transcriptionStatus).toBe('generating');
    expect(afterFirst.audioPath).toEndWith(`${queued.lessonId}.mp3`);
    expect(fs.statSync(afterFirst.audioPath!).size).toBe(afterFirst.audioBytes!);
    expect(episode()).toMatchObject({ paraDone: 1, status: 'generating', attempts: 0 });

    const firstSegments = segments(queued.lessonId);
    expect(firstSegments.map((s) => [s.lang, s.text])).toEqual([
      ['en', expect.stringContaining('Welcome. In this episode we read «Глава», from «Книга»')],
      ['en', 'Paragraph 1.'],
      [null, 'Кот видит дом.'],
      ['en', '«кот» is explained.'],
      [null, 'Дом большой.'],
      ['en', '«большой» is explained.'],
      ['en', 'Now the whole paragraph.'],
      [null, 'Кот видит дом.'],
      [null, 'Дом большой.'],
      ['en', 'In English.'],
      ['en', 'The cat sees a house. The house is big.'],
    ]);
    expect(requests[0].sentences.map((s) => s.words.map((w) => w.word))).toEqual([
      ['кот', 'видит'],
      ['большой'],
    ]);
    expect(requests[0].sentences[0].words[0].facts).toBe('gloss of кот');

    expect(await processNextParagraph(deps)).toEqual({ state: 'done', episodeId: queued.id });
    const done = lesson(queued.lessonId)!;
    expect(done.transcriptionStatus).toBe('done');
    expect(episode()).toMatchObject({ paraDone: 2, status: 'done' });
    expect(episode().completedAt).not.toBeNull();
    const all = segments(queued.lessonId);
    const second = all.slice(firstSegments.length);
    expect(second.map((s) => s.text)).toEqual([
      'Paragraph 2.',
      'Кот спит.',
      '«спит» is explained.',
      'That is the end of this episode. Thank you for listening.',
    ]);
    expect(second[0].startMs).toBeGreaterThanOrEqual(afterFirst.audioDurationMs!);
    expect(all.map((s) => s.idx)).toEqual(all.map((_, i) => i));
    expect(requests[1].previous).toBe(PARAGRAPHS[0]);
    expect(requests[1].sentences[0].words).toEqual([{ word: 'спит', facts: 'gloss of спит' }]);
    expect(await processNextParagraph(deps)).toEqual({ state: 'idle' });
  });

  test('reads a long paragraph in chunks, each with its re-read and translation', async () => {
    const queued = queueEpisode(['Кот спит. Кот ест. Кот видит дом. Дом большой.']);
    await processNextParagraph(deps);
    const texts = segments(queued.lessonId).map((s) => s.text);
    const at = (text: string) => texts.indexOf(text);
    expect(requests.map((r) => r.sentences.map((s) => s.text))).toEqual([
      ['Кот спит.', 'Кот ест.', 'Кот видит дом.'],
      ['Дом большой.'],
    ]);
    expect(requests[1].previous).toBe('Кот спит. Кот ест. Кот видит дом.');
    expect(requests[1].sentences[0].words.map((w) => w.word)).toEqual(['большой']);
    expect(at('Paragraph 1.')).toBeLessThan(at('Now the whole paragraph.'));
    expect(at('Now the whole paragraph.')).toBeLessThan(at('In English.'));
    expect(at('In English.')).toBeLessThan(at('Paragraph 1, continued.'));
    expect(texts.filter((t) => t === 'Paragraph 1, continued.')).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith('Welcome.'))).toHaveLength(1);
    expect(texts.at(-1)).toBe('That is the end of this episode. Thank you for listening.');
  });

  test('cuts off audio a crashed step left behind', async () => {
    const queued = queueEpisode();
    await processNextParagraph(deps);
    const { audioPath, audioBytes } = lesson(queued.lessonId)!;
    fs.appendFileSync(audioPath!, new Uint8Array(500));
    await processNextParagraph(deps);
    const done = lesson(queued.lessonId)!;
    expect(fs.statSync(audioPath!).size).toBe(done.audioBytes!);
    expect(done.audioBytes!).toBeGreaterThan(audioBytes!);
  });

  test('waits before a retry and gives up after three attempts', async () => {
    const queued = queueEpisode();
    writeNotes = async () => {
      throw new Error('model down');
    };
    expect(await processNextParagraph(deps)).toEqual({
      state: 'retrying',
      episodeId: queued.id,
      error: 'model down',
    });
    expect(await processNextParagraph(deps)).toEqual({ state: 'idle' });

    const past = () =>
      db
        .prepare('UPDATE podcast_episodes SET updatedAt = ? WHERE userId = ?')
        .run('2000-01-01T00:00:00.000Z', USER);
    past();
    expect((await processNextParagraph(deps)).state).toBe('retrying');
    past();
    expect(await processNextParagraph(deps)).toEqual({
      state: 'failed',
      episodeId: queued.id,
      error: 'model down',
    });
    expect(episode()).toMatchObject({ status: 'error', error: 'model down', attempts: 3 });
    expect(lesson(queued.lessonId)!.transcriptionStatus).toBe('done');
  });

  test('fails at once on a plan limit', async () => {
    queueEpisode();
    writeNotes = async () => {
      throw new PodcastLimitError('The monthly AI request limit is reached.');
    };
    expect((await processNextParagraph(deps)).state).toBe('failed');
    expect(episode()).toMatchObject({ status: 'error', attempts: 1 });
  });

  test('drops an episode whose lesson was deleted', async () => {
    const queued = queueEpisode();
    db.prepare('DELETE FROM lessons WHERE id = ?').run(queued.lessonId);
    expect(await processNextParagraph(deps)).toEqual({ state: 'dropped', episodeId: queued.id });
    expect(episode()).toBeNull();
  });

  test('discards the audio of an episode deleted while it rendered', async () => {
    const queued = queueEpisode();
    await processNextParagraph(deps);
    const { audioPath } = lesson(queued.lessonId)!;
    writeNotes = async (_userId, request) => {
      deleteEpisode(USER, queued.id);
      return notesFor(request);
    };
    expect(await processNextParagraph(deps)).toEqual({ state: 'dropped', episodeId: queued.id });
    expect(fs.existsSync(audioPath!)).toBe(false);
    expect(db.prepare('SELECT 1 FROM collections WHERE userId = ?').get(USER)).toBeNull();
  });
});
