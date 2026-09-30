import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

export interface AsrAudio {
  path: string;
  /** Deletes the extracted copy. A no-op when the original file is sent. */
  cleanup(): void;
}

const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

/** The first audio track as mono 16 kHz Opus. Falls back to the original file
 * when ffmpeg is missing or fails, or when the copy would not be smaller. */
export async function prepareAsrAudio(sourcePath: string, ffmpeg = 'ffmpeg'): Promise<AsrAudio> {
  const original: AsrAudio = { path: sourcePath, cleanup: () => {} };
  const dest = path.join(os.tmpdir(), `lector-asr-${randomUUID()}.ogg`);
  const remove = () => fs.rmSync(dest, { force: true });
  try {
    const proc = Bun.spawn(
      [
        ffmpeg,
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-i',
        sourcePath,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        dest,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    const timer = setTimeout(() => proc.kill(), EXTRACT_TIMEOUT_MS);
    await proc.exited;
    clearTimeout(timer);
    if (proc.exitCode !== 0) {
      remove();
      return original;
    }
    const size = fs.statSync(dest).size;
    if (size === 0 || size >= fs.statSync(sourcePath).size) {
      remove();
      return original;
    }
    return { path: dest, cleanup: remove };
  } catch {
    remove();
    return original;
  }
}
