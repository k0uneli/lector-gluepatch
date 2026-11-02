// Disk storage helpers for uploaded lesson audio (#185): one file per lesson
// under AUDIO_DIR (never SQLite). Shared by the import route (write), the
// audio-serving route (content type), and the lesson/collection delete routes
// (cleanup — SQLite can't cascade a file).

import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { AUDIO_DIR } from '../db';

// Containers <audio> can play and Whisper backends accept. Keys are the
// canonical stored extension; the content type serves both range requests and
// the ASR multipart part.
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
};

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);

const VIDEO_CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function videoContentType(filePath: string): string {
  return VIDEO_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** The upload's extension, lowercased, when it's a supported audio container; null otherwise. */
export function allowedAudioExtension(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  return ext in AUDIO_CONTENT_TYPES ? ext : null;
}

export function audioContentType(filePath: string): string {
  return AUDIO_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function audioPathForLesson(lessonId: string, extension: string): string {
  return path.join(AUDIO_DIR, `${lessonId}${extension}`);
}

/** Atomic tmp-write + rename (the tts-cache idiom) so a crash mid-write never
 * leaves a half file where the transcription job will look for it. */
export async function saveAudioFile(destPath: string, data: Blob | ArrayBuffer): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.${randomUUID()}.tmp`;
  await Bun.write(tmpPath, data);
  fs.renameSync(tmpPath, destPath);
}

/**
 * Best-effort unlink for a lesson's audio on delete. Refuses paths outside
 * AUDIO_DIR — audioPath comes from the DB, and a tampered/restored row must
 * never turn a lesson delete into an arbitrary-file delete.
 */
export function deleteAudioFile(audioPath: string | null | undefined): void {
  if (!audioPath) return;
  const resolved = path.resolve(audioPath);
  if (!resolved.startsWith(path.resolve(AUDIO_DIR) + path.sep)) return;
  try {
    fs.unlinkSync(resolved);
  } catch {
    /* already gone */
  }
}

/**
 * Serve a file with `Range` support (206 + Content-Range). Browsers refuse to
 * scrub an <audio> or <video> element without it.
 */
export function serveRangedFile(
  file: ReturnType<typeof Bun.file>,
  contentType: string,
  range: string | undefined,
): Response {
  const size = file.size;
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] !== '' || match[2] !== '')) {
    // Suffix form (bytes=-N) means "the last N bytes".
    const start =
      match[1] === '' ? Math.max(0, size - parseInt(match[2], 10)) : parseInt(match[1], 10);
    let end = match[1] !== '' && match[2] !== '' ? parseInt(match[2], 10) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  return new Response(file, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
    },
  });
}
