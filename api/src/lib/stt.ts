import { db } from '../db';
import { DEFAULT_ASR_MODEL, DEFAULT_ASR_URL } from './transcription/openai-whisper';
import type { STT_PROTOCOLS, STT_SOURCES } from './settings-keys';

export type SttSource = (typeof STT_SOURCES)[number];
export type SttProtocol = (typeof STT_PROTOCOLS)[number];

export interface SttConfig {
  source: SttSource;
  protocol: SttProtocol;
  /** No trailing slash and no `/v1` suffix; empty when a custom source has no URL yet. */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type SttServerMessage =
  | { type: 'ready' }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'error'; error: string };

export interface SttSession {
  /** Mono PCM16 little-endian at STT_SAMPLE_RATE. */
  pushAudio(pcm: Uint8Array): void;
  /** Emit the final transcript, then close. */
  finish(): void;
  abort(): void;
}

export type SttEmit = (message: SttServerMessage) => void;

/** Mirrors STT_SAMPLE_RATE in src/lib/stt/audio.ts. */
export const STT_SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = STT_SAMPLE_RATE * 2;
const MAX_SESSION_SECONDS = 30;
const MAX_SESSION_BYTES = MAX_SESSION_SECONDS * BYTES_PER_SECOND;

const PARTIAL_INTERVAL_MS = 400;
const MIN_NEW_PARTIAL_BYTES = BYTES_PER_SECOND / 4;
const REQUEST_TIMEOUT_MS = 15_000;
const REALTIME_DONE_TIMEOUT_MS = 10_000;
// vLLM sends session.created on connect; other servers may not.
const REALTIME_CREATED_GRACE_MS = 1_500;

function readSetting(userId: string, key: string): unknown {
  const row = db
    .prepare('SELECT value FROM settings WHERE userId = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function readString(userId: string, key: string): string {
  const value = readSetting(userId, key);
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSttBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1(\/realtime|\/audio\/transcriptions)?$/, '');
}

/** The `asr` source reads the same env as audio-lesson transcription. */
export function resolveSttConfig(userId: string): SttConfig {
  if (readSetting(userId, 'sttSource') === 'custom') {
    return {
      source: 'custom',
      protocol: readSetting(userId, 'sttProtocol') === 'http' ? 'http' : 'realtime',
      baseUrl: normalizeSttBaseUrl(readString(userId, 'sttUrl')),
      model: readString(userId, 'sttModel'),
      apiKey: readString(userId, 'sttApiKey') || undefined,
    };
  }
  return {
    source: 'asr',
    protocol: 'http',
    baseUrl: normalizeSttBaseUrl(process.env.ASR_URL || DEFAULT_ASR_URL),
    model: process.env.ASR_MODEL || DEFAULT_ASR_MODEL,
    apiKey: process.env.ASR_API_KEY || undefined,
  };
}

function authHeaders(config: SttConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

export function realtimeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}/v1/realtime`;
}

export async function checkSttHealth(config: SttConfig): Promise<{ ok: boolean; error?: string }> {
  if (!config.baseUrl) return { ok: false, error: 'No endpoint set' };
  try {
    const response = await fetch(`${config.baseUrl}/v1/models`, {
      headers: authHeaders(config),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { ok: false, error: `Endpoint returned ${response.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: `Cannot reach ${config.baseUrl}` };
  }
}

export function pcm16ToWav(pcm: Uint8Array, sampleRate = STT_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

export type ClipTranscriber = (
  config: SttConfig,
  wav: Uint8Array<ArrayBuffer>,
  language: string,
  signal: AbortSignal,
) => Promise<string>;

export const transcribeClip: ClipTranscriber = async (config, wav, language, signal) => {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  if (config.model) form.append('model', config.model);
  form.append('language', language);
  form.append('response_format', 'json');

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(config),
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(`Cannot reach the speech recognizer at ${config.baseUrl}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`Speech recognizer returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = (await response.json()) as { text?: unknown };
  return typeof data.text === 'string' ? data.text.trim() : '';
};

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const part = chunk.subarray(0, size - offset);
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Speech recognition failed';
}

/**
 * For `/v1/audio/transcriptions` servers, which cannot stream: the whole clip
 * so far is re-sent every PARTIAL_INTERVAL_MS, and each answer is a partial.
 */
export class HttpSttSession implements SttSession {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private lastText = '';
  private lastTextBytes = 0;
  private inFlight: Promise<void> | null = null;
  private finished = false;
  private aborted = false;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: SttConfig,
    private readonly language: string,
    private readonly emit: SttEmit,
    private readonly close: () => void,
    private readonly transcribe: ClipTranscriber = transcribeClip,
  ) {
    this.timer = setInterval(() => this.tick(), PARTIAL_INTERVAL_MS);
    emit({ type: 'ready' });
  }

  pushAudio(pcm: Uint8Array): void {
    if (this.finished || this.aborted) return;
    const room = MAX_SESSION_BYTES - this.bytes;
    if (room <= 0) return;
    const part = pcm.byteLength > room ? pcm.subarray(0, room) : pcm;
    this.chunks.push(part.slice());
    this.bytes += part.byteLength;
  }

  private tick(): void {
    if (this.finished || this.aborted || this.inFlight) return;
    if (this.bytes - this.lastTextBytes < MIN_NEW_PARTIAL_BYTES) return;
    this.inFlight = this.run(this.bytes)
      .then((ok) => {
        if (ok && !this.finished && !this.aborted) {
          this.emit({ type: 'transcript', text: this.lastText, final: false });
        }
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  private async run(size: number): Promise<boolean> {
    try {
      const wav = pcm16ToWav(concat(this.chunks, size));
      this.lastText = await this.transcribe(
        this.config,
        wav,
        this.language,
        this.controller.signal,
      );
      this.lastTextBytes = size;
      return true;
    } catch (err) {
      if (!this.aborted) this.fail(errorMessage(err));
      return false;
    }
  }

  private fail(message: string): void {
    if (this.aborted) return;
    this.emit({ type: 'error', error: message });
    this.abort();
    this.close();
  }

  finish(): void {
    if (this.finished || this.aborted) return;
    this.finished = true;
    clearInterval(this.timer);
    void this.finalize();
  }

  private async finalize(): Promise<void> {
    await this.inFlight;
    if (this.aborted) return;
    if (this.bytes > this.lastTextBytes && !(await this.run(this.bytes))) return;
    if (this.aborted) return;
    this.emit({ type: 'transcript', text: this.lastText, final: true });
    this.abort();
    this.close();
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    clearInterval(this.timer);
    this.controller.abort();
  }
}

type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

// Bun accepts upgrade headers here; the DOM typings in scope do not declare them.
const HeaderedWebSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

const defaultWebSocketFactory: WebSocketFactory = (url, headers) =>
  new HeaderedWebSocket(url, { headers });

/** Relays to vLLM's `/v1/realtime` (base64 PCM16 in, `transcription.delta` out). */
export class RealtimeSttSession implements SttSession {
  private readonly ws: WebSocket;
  private readonly url: string;
  private queue: Uint8Array[] = [];
  private bytes = 0;
  private text = '';
  private started = false;
  private finishing = false;
  private closed = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: SttConfig,
    private readonly emit: SttEmit,
    private readonly close: () => void,
    createWebSocket: WebSocketFactory = defaultWebSocketFactory,
  ) {
    this.url = realtimeUrl(config.baseUrl);
    this.ws = createWebSocket(this.url, authHeaders(config));
    this.ws.onopen = () => {
      this.graceTimer = setTimeout(() => this.start(), REALTIME_CREATED_GRACE_MS);
    };
    this.ws.onmessage = (event) => this.onUpstream(event.data);
    this.ws.onerror = () => this.fail(`Cannot reach the speech recognizer at ${this.url}`);
    this.ws.onclose = () => {
      if (!this.closed) this.fail('The speech recognizer closed the connection');
    };
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.config.model) this.send({ type: 'session.update', model: this.config.model });
    this.send({ type: 'input_audio_buffer.commit' });
    for (const chunk of this.queue) this.append(chunk);
    this.queue = [];
    this.emit({ type: 'ready' });
    if (this.finishing) this.send({ type: 'input_audio_buffer.commit', final: true });
  }

  private append(pcm: Uint8Array): void {
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') });
  }

  private onUpstream(raw: unknown): void {
    if (this.closed || typeof raw !== 'string') return;
    let message: { type?: unknown; delta?: unknown; text?: unknown; error?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message.type) {
      case 'session.created':
        this.start();
        return;
      case 'transcription.delta':
        if (typeof message.delta !== 'string' || !message.delta) return;
        this.text += message.delta;
        this.emit({ type: 'transcript', text: this.text.trim(), final: false });
        return;
      case 'transcription.done':
        if (typeof message.text === 'string') this.text = message.text;
        this.complete();
        return;
      case 'error': {
        const error = message.error as unknown;
        const detail =
          typeof error === 'string'
            ? error
            : typeof (error as { message?: unknown })?.message === 'string'
              ? (error as { message: string }).message
              : 'Speech recognition failed';
        this.fail(detail);
        return;
      }
    }
  }

  pushAudio(pcm: Uint8Array): void {
    if (this.closed || this.finishing) return;
    const room = MAX_SESSION_BYTES - this.bytes;
    if (room <= 0) return;
    const part = pcm.byteLength > room ? pcm.subarray(0, room) : pcm;
    this.bytes += part.byteLength;
    if (this.started) this.append(part);
    else this.queue.push(part.slice());
  }

  finish(): void {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    if (this.started) this.send({ type: 'input_audio_buffer.commit', final: true });
    this.doneTimer = setTimeout(() => this.complete(), REALTIME_DONE_TIMEOUT_MS);
  }

  private complete(): void {
    if (this.closed) return;
    this.emit({ type: 'transcript', text: this.text.trim(), final: true });
    this.abort();
    this.close();
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.emit({ type: 'error', error: message });
    this.abort();
    this.close();
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.doneTimer) clearTimeout(this.doneTimer);
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

export function openSttSession(
  config: SttConfig,
  language: string,
  emit: SttEmit,
  close: () => void,
): SttSession {
  if (!config.baseUrl) {
    emit({ type: 'error', error: 'No speech recognition endpoint is set' });
    close();
    return { pushAudio() {}, finish() {}, abort() {} };
  }
  return config.protocol === 'realtime'
    ? new RealtimeSttSession(config, emit, close)
    : new HttpSttSession(config, language, emit, close);
}
