import fs from 'fs';
import path from 'path';
import { isTargetLine, type LineKind, type ScriptLine } from './script';
import { narrationRuns, type VoiceRun } from './text';

/** Mono 16-bit PCM at this rate is the working format for every clip. */
export const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;
/**
 * Episode audio is CBR MP3 frames with no ID3 or Xing header, so paragraph
 * files append byte for byte and the duration follows from the byte count.
 */
const BITRATE_KBPS = 64;
const MP3_BYTES_PER_MS = BITRATE_KBPS / 8;
const FFMPEG_TIMEOUT_MS = 120_000;

const PAUSE_BETWEEN_RUNS_MS = 150;
const PAUSE_AFTER_MS: Record<LineKind, number> = {
  intro: 800,
  heading: 600,
  slow: 1000,
  note: 700,
  read: 350,
  outro: 0,
};
const PAUSE_AFTER_PARAGRAPH_MS = 1200;

export interface AudioToolkit {
  /** Any container in, mono s16le PCM at SAMPLE_RATE out. `tempo` below 1 slows the speech. */
  decode(audio: Uint8Array, tempo: number): Promise<Uint8Array>;
  /** PCM in, headerless CBR MP3 frames out. */
  encode(pcm: Uint8Array): Promise<Uint8Array>;
}

async function runFfmpeg(ffmpeg: string, args: string[], input: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn([ffmpeg, '-v', 'error', ...args], {
    stdin: new Blob([input as BlobPart]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), FFMPEG_TIMEOUT_MS);
  try {
    const [output, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `ffmpeg exited ${exitCode}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`,
      );
    }
    return new Uint8Array(output);
  } finally {
    clearTimeout(timer);
  }
}

export function ffmpegToolkit(ffmpeg = 'ffmpeg'): AudioToolkit {
  return {
    decode: (audio, tempo) =>
      runFfmpeg(
        ffmpeg,
        [
          '-i',
          'pipe:0',
          ...(tempo !== 1 ? ['-af', `atempo=${tempo.toFixed(3)}`] : []),
          '-ac',
          '1',
          '-ar',
          String(SAMPLE_RATE),
          '-f',
          's16le',
          'pipe:1',
        ],
        audio,
      ),
    encode: (pcm) =>
      runFfmpeg(
        ffmpeg,
        [
          '-f',
          's16le',
          '-ar',
          String(SAMPLE_RATE),
          '-ac',
          '1',
          '-i',
          'pipe:0',
          '-c:a',
          'libmp3lame',
          '-b:a',
          `${BITRATE_KBPS}k`,
          '-id3v2_version',
          '0',
          '-write_xing',
          '0',
          '-f',
          'mp3',
          'pipe:1',
        ],
        pcm,
      ),
  };
}

export function mp3DurationMs(bytes: number): number {
  return Math.round(bytes / MP3_BYTES_PER_MS);
}

function silence(ms: number): Uint8Array {
  return new Uint8Array(Math.round((ms * SAMPLE_RATE) / 1000) * BYTES_PER_SAMPLE);
}

function pcmMs(bytes: number): number {
  return (bytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
}

/** What each line says, and in which voice. */
export function lineRuns(line: ScriptLine): VoiceRun[] {
  return isTargetLine(line) ? [{ text: line.text, voice: 'target' }] : narrationRuns(line.text);
}

export interface LineCue {
  /** Index into the rendered lines. */
  line: number;
  startMs: number;
  endMs: number;
}

export interface RenderedParagraph {
  mp3: Uint8Array;
  durationMs: number;
  cues: LineCue[];
}

export async function renderParagraph(
  lines: readonly ScriptLine[],
  speak: (run: VoiceRun) => Promise<Uint8Array>,
  toolkit: AudioToolkit,
  opts: { slowTempo: number },
): Promise<RenderedParagraph> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    bytes += chunk.byteLength;
  };
  const cues: LineCue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const runs = lineRuns(line);
    if (runs.length === 0) continue;
    const startMs = pcmMs(bytes);
    for (let r = 0; r < runs.length; r++) {
      if (r > 0) push(silence(PAUSE_BETWEEN_RUNS_MS));
      const tempo = line.kind === 'slow' ? opts.slowTempo : 1;
      push(await toolkit.decode(await speak(runs[r]), tempo));
    }
    cues.push({ line: i, startMs: Math.round(startMs), endMs: Math.round(pcmMs(bytes)) });
    push(silence(PAUSE_AFTER_MS[line.kind]));
  }
  push(silence(PAUSE_AFTER_PARAGRAPH_MS));

  const pcm = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const mp3 = await toolkit.encode(pcm);
  return { mp3, durationMs: mp3DurationMs(mp3.byteLength), cues };
}

/**
 * Append a paragraph to the episode file. The file is first cut back to
 * `committedBytes`, so a paragraph that failed after its write is not doubled.
 */
export function appendEpisodeAudio(
  filePath: string,
  committedBytes: number,
  audio: Uint8Array,
): number {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (size < committedBytes)
    throw new Error('The episode audio file is shorter than its saved paragraphs');
  if (size > committedBytes) fs.truncateSync(filePath, committedBytes);
  fs.appendFileSync(filePath, audio);
  return committedBytes + audio.byteLength;
}
