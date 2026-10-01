import '../test-guard';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { clipWindow, cutAudioClip } from './audio-clip';

const hasFfmpeg = Bun.which('ffmpeg') !== null && Bun.which('ffprobe') !== null;
const DIR = path.join(process.env.DATA_DIR || '.test-data', 'audio-clip');

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${args[0]} failed`);
  return out;
}

describe('clipWindow', () => {
  test('pads the span on both sides', () => {
    expect(clipWindow(2000, 4000)).toEqual({ startMs: 1850, durationMs: 2450 });
  });

  test('never starts before zero', () => {
    expect(clipWindow(100, 1000)).toEqual({ startMs: 0, durationMs: 1300 });
  });
});

describe.skipIf(!hasFfmpeg)('cutAudioClip', () => {
  const source = path.join(DIR, 'tone.mp4');

  beforeAll(async () => {
    fs.mkdirSync(DIR, { recursive: true });
    // A 10 s video file with a stereo tone, like an uploaded video lesson.
    await run([
      'ffmpeg',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:d=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=10',
      '-ac',
      '2',
      '-shortest',
      source,
    ]);
  });

  afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

  test('cuts the padded span of the audio track to mono MP3', async () => {
    const clip = await cutAudioClip(source, 3000, 5000);
    expect(clip).not.toBeNull();
    const out = path.join(DIR, 'clip.mp3');
    fs.writeFileSync(out, clip!);

    const probe = JSON.parse(
      await run([
        'ffprobe',
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,channels:format=duration',
        '-of',
        'json',
        out,
      ]),
    );
    expect(probe.streams).toEqual([{ codec_type: 'audio', codec_name: 'mp3', channels: 1 }]);
    // 2.45 s window; MP3 frames are 26 ms, so allow a few frames either way.
    const duration = Number(probe.format.duration);
    expect(duration).toBeGreaterThan(2.3);
    expect(duration).toBeLessThan(2.6);
  });

  test('returns null for a file that is not media', async () => {
    const junk = path.join(DIR, 'junk.mp3');
    fs.writeFileSync(junk, 'not audio');
    expect(await cutAudioClip(junk, 0, 1000)).toBeNull();
  });
});

test('returns null when ffmpeg is missing', async () => {
  expect(await cutAudioClip('/nonexistent.mp3', 0, 1000, 'lector-no-such-ffmpeg')).toBeNull();
});
