import '../test-guard';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { prepareAsrAudio } from './asr-audio';

const hasFfmpeg = Bun.which('ffmpeg') !== null && Bun.which('ffprobe') !== null;
const DIR = path.join(process.env.DATA_DIR || '.test-data', 'asr-audio');

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${args[0]} failed`);
  return out;
}

async function streams(
  file: string,
): Promise<{ codec_type: string; codec_name: string; channels?: number }[]> {
  const out = await run([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,channels',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(out).streams;
}

async function durationSeconds(file: string): Promise<number> {
  const out = await run([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return parseFloat(out);
}

describe.skipIf(!hasFfmpeg)('prepareAsrAudio', () => {
  const video = path.join(DIR, 'film.mp4');
  const wav = path.join(DIR, 'speech.wav');

  beforeAll(async () => {
    fs.mkdirSync(DIR, { recursive: true });
    await run([
      'ffmpeg',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=25:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'mpeg4',
      '-q:v',
      '2',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      video,
    ]);
    await run([
      'ffmpeg',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-ac',
      '2',
      '-ar',
      '44100',
      wav,
    ]);
  });
  afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

  test('keeps only the audio of a video, as mono Opus of the same length', async () => {
    const audio = await prepareAsrAudio(video);

    expect(audio.path).not.toBe(video);
    expect(audio.path.endsWith('.ogg')).toBe(true);
    expect(await streams(audio.path)).toEqual([
      { codec_type: 'audio', codec_name: 'opus', channels: 1 },
    ]);
    expect(Math.abs((await durationSeconds(audio.path)) - 4)).toBeLessThan(0.2);
    expect(fs.statSync(audio.path).size).toBeLessThan(fs.statSync(video).size);

    audio.cleanup();
    expect(fs.existsSync(audio.path)).toBe(false);
  });

  test('shrinks an uncompressed audio file too', async () => {
    const audio = await prepareAsrAudio(wav);
    expect(audio.path).not.toBe(wav);
    expect(fs.statSync(audio.path).size).toBeLessThan(fs.statSync(wav).size / 10);
    audio.cleanup();
  });

  test('falls back to the original for a file ffmpeg cannot read', async () => {
    const junk = path.join(DIR, 'junk.webm');
    fs.writeFileSync(junk, new Uint8Array(4096).fill(7));

    const audio = await prepareAsrAudio(junk);

    expect(audio.path).toBe(junk);
    audio.cleanup();
    expect(fs.existsSync(junk)).toBe(true);
  });
});

describe('prepareAsrAudio without ffmpeg', () => {
  test('falls back to the original file', async () => {
    const audio = await prepareAsrAudio('/tmp/whatever.webm', 'ffmpeg-is-not-installed');
    expect(audio.path).toBe('/tmp/whatever.webm');
  });
});
