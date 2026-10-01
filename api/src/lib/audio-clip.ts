/** Longest clip the clip route cuts, in ms. A transcript line is far shorter. */
export const MAX_CLIP_MS = 60_000;

// ASR segment bounds sit tight on the speech, so the clip opens this much
// earlier and closes this much later (ms) to keep the first and last syllables.
const CLIP_LEAD_MS = 150;
const CLIP_TAIL_MS = 300;

const CUT_TIMEOUT_MS = 30_000;

/** The padded window a clip covers, in ms. */
export function clipWindow(
  startMs: number,
  endMs: number,
): { startMs: number; durationMs: number } {
  const start = Math.max(0, startMs - CLIP_LEAD_MS);
  return { startMs: start, durationMs: endMs + CLIP_TAIL_MS - start };
}

/**
 * Cut [startMs, endMs] of the first audio track to mono MP3 — the format every
 * Anki client plays. Null when ffmpeg is missing or fails.
 */
export async function cutAudioClip(
  sourcePath: string,
  startMs: number,
  endMs: number,
  ffmpeg = 'ffmpeg',
): Promise<Uint8Array<ArrayBuffer> | null> {
  const window = clipWindow(startMs, endMs);
  try {
    const proc = Bun.spawn(
      [
        ffmpeg,
        '-nostdin',
        '-v',
        'error',
        '-ss',
        (window.startMs / 1000).toFixed(3),
        '-i',
        sourcePath,
        '-t',
        (window.durationMs / 1000).toFixed(3),
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-c:a',
        'libmp3lame',
        '-q:a',
        '4',
        '-f',
        'mp3',
        'pipe:1',
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const timer = setTimeout(() => proc.kill(), CUT_TIMEOUT_MS);
    const [audio, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (exitCode !== 0 || audio.byteLength === 0) return null;
    return new Uint8Array(audio);
  } catch {
    return null;
  }
}
