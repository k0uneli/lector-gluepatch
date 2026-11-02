import '../../test-guard';
import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  appendEpisodeAudio,
  ffmpegToolkit,
  lineRuns,
  mp3DurationMs,
  renderParagraph,
  SAMPLE_RATE,
  type AudioToolkit,
} from './audio';

const hasFfmpeg = Bun.which('ffmpeg') !== null;

/** Every run decodes to 100 ms of PCM per character; encoding keeps one MP3 byte per PCM byte. */
const fakeToolkit: AudioToolkit = {
  async decode(audio, tempo) {
    const ms = (audio.byteLength * 100) / tempo;
    return new Uint8Array(Math.round((ms * SAMPLE_RATE) / 1000) * 2);
  },
  async encode(pcm) {
    return new Uint8Array(Math.floor(pcm.byteLength / 6));
  },
};

const speakLength = async (run: { text: string }) => new Uint8Array(run.text.length);

describe('lineRuns', () => {
  test('target lines are one run; narration splits by voice', () => {
    expect(lineRuns({ kind: 'slow', text: 'Кот «тут».' })).toEqual([
      { text: 'Кот «тут».', voice: 'target' },
    ]);
    expect(lineRuns({ kind: 'note', text: 'Say «кот».' })).toEqual([
      { text: 'Say', voice: 'en' },
      { text: 'кот', voice: 'target' },
    ]);
  });
});

describe('renderParagraph', () => {
  test('gives each spoken line a cue, with pauses between them', async () => {
    const spoken: string[] = [];
    const rendered = await renderParagraph(
      [
        { kind: 'heading', text: 'P 1.' },
        { kind: 'slow', text: 'Кот' },
        { kind: 'note', text: '«»' },
        { kind: 'note', text: 'Ab «cd»' },
      ],
      async (run) => {
        spoken.push(`${run.voice}:${run.text}`);
        return speakLength(run);
      },
      fakeToolkit,
      { slowTempo: 0.5 },
    );
    expect(spoken).toEqual(['en:P 1.', 'target:Кот', 'en:Ab', 'target:cd']);
    // heading 400 ms + 600 pause; slow 300 ms at half speed = 600 ms + 1000 pause;
    // note: 200 ms + 150 gap + 200 ms.
    expect(rendered.cues).toEqual([
      { line: 0, startMs: 0, endMs: 400 },
      { line: 1, startMs: 1000, endMs: 1600 },
      { line: 3, startMs: 2600, endMs: 3150 },
    ]);
    expect(rendered.durationMs).toBe(mp3DurationMs(rendered.mp3.byteLength));
  });
});

describe('appendEpisodeAudio', () => {
  test('appends after the committed bytes and cuts off an uncommitted tail', () => {
    const dir = fs.mkdtempSync(path.join(path.resolve('.test-data'), 'podcast-audio-'));
    const file = path.join(dir, 'episode.mp3');
    expect(appendEpisodeAudio(file, 0, new Uint8Array([1, 2]))).toBe(2);
    expect(appendEpisodeAudio(file, 2, new Uint8Array([3]))).toBe(3);
    fs.appendFileSync(file, new Uint8Array([9, 9]));
    expect(appendEpisodeAudio(file, 3, new Uint8Array([4]))).toBe(4);
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3, 4]);
    expect(() => appendEpisodeAudio(file, 10, new Uint8Array([5]))).toThrow('shorter');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!hasFfmpeg)('ffmpegToolkit', () => {
  test('decodes, slows down and encodes headerless MP3 whose length gives its duration', async () => {
    const tone = Bun.spawnSync([
      'ffmpeg',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-f',
      'wav',
      'pipe:1',
    ]);
    const toolkit = ffmpegToolkit();
    const normal = await toolkit.decode(new Uint8Array(tone.stdout), 1);
    const slow = await toolkit.decode(new Uint8Array(tone.stdout), 0.5);
    expect(normal.byteLength / 2 / SAMPLE_RATE).toBeCloseTo(1, 1);
    expect(slow.byteLength / 2 / SAMPLE_RATE).toBeCloseTo(2, 1);

    const mp3 = await toolkit.encode(slow);
    expect([mp3[0], mp3[1] & 0xe0]).toEqual([0xff, 0xe0]);
    const dir = fs.mkdtempSync(path.join(path.resolve('.test-data'), 'podcast-ffmpeg-'));
    const file = path.join(dir, 'twice.mp3');
    fs.writeFileSync(file, Buffer.concat([mp3, mp3]));
    const probe = Bun.spawnSync([
      'ffprobe',
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      file,
    ]);
    expect(Math.round(parseFloat(probe.stdout.toString()) * 1000)).toBe(
      mp3DurationMs(mp3.byteLength * 2),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rejects audio ffmpeg cannot read', async () => {
    await expect(ffmpegToolkit().decode(new Uint8Array([1, 2, 3]), 1)).rejects.toThrow(
      'ffmpeg exited',
    );
  });
});
