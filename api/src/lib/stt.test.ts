import '../test-guard';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../db';
import {
  HttpSttSession,
  RealtimeSttSession,
  normalizeSttBaseUrl,
  pcm16ToWav,
  resolveSttConfig,
  transcribeClip,
  type ClipTranscriber,
  type SttConfig,
  type SttServerMessage,
} from './stt';

const USER = 'stt-lib-test-user';
const ONE_SECOND = 32_000;

function setSetting(key: string, value: unknown) {
  db.prepare('INSERT OR REPLACE INTO settings (userId, key, value) VALUES (?, ?, ?)').run(
    USER,
    key,
    JSON.stringify(value),
  );
}

async function waitFor(check: () => boolean, timeoutMs = 4_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await Bun.sleep(10);
  }
}

function recorder() {
  const state = { messages: [] as SttServerMessage[], closed: false };
  return {
    state,
    emit: (message: SttServerMessage) => state.messages.push(message),
    close: () => {
      state.closed = true;
    },
    transcripts: () =>
      state.messages.filter(
        (m): m is Extract<SttServerMessage, { type: 'transcript' }> => m.type === 'transcript',
      ),
  };
}

function audio(bytes: number, fill = 1): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

const HTTP_CONFIG: SttConfig = {
  source: 'custom',
  protocol: 'http',
  baseUrl: 'http://unused.invalid',
  model: 'whisper-1',
};

describe('normalizeSttBaseUrl', () => {
  test('strips trailing slashes and the OpenAI paths', () => {
    expect(normalizeSttBaseUrl(' http://localhost:8000/ ')).toBe('http://localhost:8000');
    expect(normalizeSttBaseUrl('http://localhost:8000/v1')).toBe('http://localhost:8000');
    expect(normalizeSttBaseUrl('http://gpu:8000/v1/realtime')).toBe('http://gpu:8000');
    expect(normalizeSttBaseUrl('https://api.groq.com/openai/v1/audio/transcriptions')).toBe(
      'https://api.groq.com/openai',
    );
  });
});

describe('resolveSttConfig', () => {
  const saved = {
    url: process.env.ASR_URL,
    model: process.env.ASR_MODEL,
    key: process.env.ASR_API_KEY,
  };

  function restoreEnv() {
    for (const [name, value] of [
      ['ASR_URL', saved.url],
      ['ASR_MODEL', saved.model],
      ['ASR_API_KEY', saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  beforeEach(restoreEnv);
  afterEach(() => {
    restoreEnv();
    db.prepare('DELETE FROM settings WHERE userId = ?').run(USER);
  });

  test('defaults to the audio-import ASR server from the environment', () => {
    process.env.ASR_URL = 'http://asr.local:9000/';
    process.env.ASR_MODEL = 'whisper-small';
    process.env.ASR_API_KEY = 'asr-key';

    expect(resolveSttConfig(USER)).toEqual({
      source: 'asr',
      protocol: 'http',
      baseUrl: 'http://asr.local:9000',
      model: 'whisper-small',
      apiKey: 'asr-key',
    });
  });

  test('falls back to the ASR defaults when the environment is empty', () => {
    delete process.env.ASR_URL;
    delete process.env.ASR_MODEL;
    delete process.env.ASR_API_KEY;

    expect(resolveSttConfig(USER)).toEqual({
      source: 'asr',
      protocol: 'http',
      baseUrl: 'http://localhost:8000',
      model: 'whisper-large-v3',
      apiKey: undefined,
    });
  });

  test('reads a custom endpoint from settings, realtime by default', () => {
    setSetting('sttSource', 'custom');
    setSetting('sttUrl', 'http://gpu:8000/v1');
    setSetting('sttModel', 'mistralai/Voxtral-Mini-4B-Realtime-2602');
    setSetting('sttApiKey', 'stt-secret');

    expect(resolveSttConfig(USER)).toEqual({
      source: 'custom',
      protocol: 'realtime',
      baseUrl: 'http://gpu:8000',
      model: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
      apiKey: 'stt-secret',
    });

    setSetting('sttProtocol', 'http');
    expect(resolveSttConfig(USER).protocol).toBe('http');
  });

  test('a custom source with no URL resolves to an empty endpoint', () => {
    setSetting('sttSource', 'custom');
    expect(resolveSttConfig(USER).baseUrl).toBe('');
  });
});

describe('pcm16ToWav', () => {
  test('writes a 16 kHz mono PCM16 header ahead of the samples', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const wav = pcm16ToWav(pcm);
    const view = new DataView(wav.buffer);
    const text = (offset: number) => new TextDecoder().decode(wav.subarray(offset, offset + 4));

    expect(wav.byteLength).toBe(48);
    expect(text(0)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(40);
    expect(text(8)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });
});

describe('transcribeClip', () => {
  let lastRequest: {
    auth: string | null;
    model: FormDataEntryValue | null;
    language: FormDataEntryValue | null;
    format: FormDataEntryValue | null;
    fileName: string;
  } | null = null;
  let status = 200;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/v1/audio/transcriptions') {
        return new Response('not found', { status: 404 });
      }
      const form = await req.formData();
      const file = form.get('file') as File;
      lastRequest = {
        auth: req.headers.get('authorization'),
        model: form.get('model'),
        language: form.get('language'),
        format: form.get('response_format'),
        fileName: file.name,
      };
      if (status !== 200) return new Response('model loading', { status });
      return Response.json({ text: '  Goeie môre  ' });
    },
  });
  afterAll(() => server.stop(true));

  const config = (): SttConfig => ({
    ...HTTP_CONFIG,
    baseUrl: `http://localhost:${server.port}`,
    apiKey: 'clip-key',
  });

  test('posts the WAV with the model and language, and trims the text', async () => {
    status = 200;
    const text = await transcribeClip(
      config(),
      pcm16ToWav(audio(64)),
      'af',
      new AbortController().signal,
    );

    expect(text).toBe('Goeie môre');
    expect(lastRequest).toEqual({
      auth: 'Bearer clip-key',
      model: 'whisper-1',
      language: 'af',
      format: 'json',
      fileName: 'speech.wav',
    });
  });

  test('names the endpoint when it cannot connect', async () => {
    await expect(
      transcribeClip(
        { ...config(), baseUrl: 'http://localhost:1' },
        pcm16ToWav(audio(64)),
        'af',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Cannot reach the speech recognizer at http://localhost:1');
  });

  test('throws with the status when the recognizer fails', async () => {
    status = 503;
    await expect(
      transcribeClip(config(), pcm16ToWav(audio(64)), 'af', new AbortController().signal),
    ).rejects.toThrow('Speech recognizer returned 503: model loading');
  });
});

describe('HttpSttSession', () => {
  test('sends partial transcripts while audio arrives, then the final one', async () => {
    const words = ['Die', 'hond', 'blaf'];
    const sizes: number[] = [];
    const transcriber: ClipTranscriber = async (_config, wav) => {
      sizes.push(wav.byteLength - 44);
      return words.slice(0, sizes.length).join(' ');
    };
    const rec = recorder();
    const session = new HttpSttSession(HTTP_CONFIG, 'af', rec.emit, rec.close, transcriber);

    expect(rec.state.messages[0]).toEqual({ type: 'ready' });

    session.pushAudio(audio(ONE_SECOND / 2));
    await waitFor(() => rec.transcripts().length === 1);
    expect(rec.transcripts()[0]).toEqual({ type: 'transcript', text: 'Die', final: false });

    session.pushAudio(audio(ONE_SECOND / 2));
    await waitFor(() => rec.transcripts().length === 2);
    expect(rec.transcripts()[1]).toEqual({ type: 'transcript', text: 'Die hond', final: false });

    session.pushAudio(audio(ONE_SECOND / 10));
    session.finish();
    await waitFor(() => rec.state.closed);

    expect(rec.transcripts().at(-1)).toEqual({
      type: 'transcript',
      text: 'Die hond blaf',
      final: true,
    });
    expect(sizes).toEqual([ONE_SECOND / 2, ONE_SECOND, ONE_SECOND + ONE_SECOND / 10]);
  });

  test('reuses the last answer as final when no audio came after it', async () => {
    let calls = 0;
    const transcriber: ClipTranscriber = async () => {
      calls++;
      return 'Goeie môre';
    };
    const rec = recorder();
    const session = new HttpSttSession(HTTP_CONFIG, 'af', rec.emit, rec.close, transcriber);

    session.pushAudio(audio(ONE_SECOND));
    await waitFor(() => rec.transcripts().length === 1);
    session.finish();
    await waitFor(() => rec.state.closed);

    expect(calls).toBe(1);
    expect(rec.transcripts().at(-1)).toEqual({
      type: 'transcript',
      text: 'Goeie môre',
      final: true,
    });
  });

  test('finishing without audio gives an empty final transcript', async () => {
    let calls = 0;
    const rec = recorder();
    const session = new HttpSttSession(HTTP_CONFIG, 'af', rec.emit, rec.close, async () => {
      calls++;
      return 'never';
    });

    session.finish();
    await waitFor(() => rec.state.closed);

    expect(calls).toBe(0);
    expect(rec.transcripts()).toEqual([{ type: 'transcript', text: '', final: true }]);
  });

  test('reports a failed request and closes', async () => {
    const rec = recorder();
    const session = new HttpSttSession(HTTP_CONFIG, 'af', rec.emit, rec.close, async () => {
      throw new Error('Speech recognizer returned 500');
    });

    session.pushAudio(audio(ONE_SECOND));
    await waitFor(() => rec.state.closed);

    expect(rec.state.messages.at(-1)).toEqual({
      type: 'error',
      error: 'Speech recognizer returned 500',
    });
    session.finish();
    expect(rec.transcripts()).toEqual([]);
  });

  test('keeps at most 30 seconds of audio', async () => {
    const sizes: number[] = [];
    const rec = recorder();
    const session = new HttpSttSession(HTTP_CONFIG, 'af', rec.emit, rec.close, async (_c, wav) => {
      sizes.push(wav.byteLength - 44);
      return '';
    });

    for (let i = 0; i < 31; i++) session.pushAudio(audio(ONE_SECOND));
    session.finish();
    await waitFor(() => rec.state.closed);

    expect(sizes.at(-1)).toBe(30 * ONE_SECOND);
  });
});

describe('RealtimeSttSession', () => {
  type Upstream = { type: string; model?: string; audio?: string; final?: boolean };
  let received: Upstream[] = [];
  let upgradeAuth: string | null = null;
  let failAppends = false;

  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname !== '/v1/realtime') {
        return new Response('not found', { status: 404 });
      }
      upgradeAuth = req.headers.get('authorization');
      return server.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: 'session.created', id: 'sess-1' }));
      },
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as Upstream;
        received.push(message);
        if (message.type === 'input_audio_buffer.append') {
          if (failAppends) {
            ws.send(JSON.stringify({ type: 'error', error: 'model overloaded' }));
            return;
          }
          const appends = received.filter((m) => m.type === 'input_audio_buffer.append').length;
          ws.send(
            JSON.stringify({ type: 'transcription.delta', delta: appends === 1 ? 'Die' : ' hond' }),
          );
        }
        if (message.type === 'input_audio_buffer.commit' && message.final) {
          ws.send(JSON.stringify({ type: 'transcription.done', text: 'Die hond.' }));
        }
      },
    },
  });
  afterAll(() => upstream.stop(true));

  beforeEach(() => {
    received = [];
    upgradeAuth = null;
    failAppends = false;
  });

  const config = (): SttConfig => ({
    source: 'custom',
    protocol: 'realtime',
    baseUrl: `http://localhost:${upstream.port}`,
    model: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
    apiKey: 'rt-key',
  });

  test('relays audio and streams the deltas as a growing transcript', async () => {
    const rec = recorder();
    const session = new RealtimeSttSession(config(), rec.emit, rec.close);
    const first = audio(3_200, 7);
    const second = audio(3_200, 9);

    session.pushAudio(first);
    await waitFor(() => rec.state.messages.some((m) => m.type === 'ready'));
    session.pushAudio(second);
    await waitFor(() => rec.transcripts().length === 2);
    session.finish();
    await waitFor(() => rec.state.closed);

    expect(upgradeAuth).toBe('Bearer rt-key');
    expect(received.map((m) => m.type)).toEqual([
      'session.update',
      'input_audio_buffer.commit',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    expect(received[0].model).toBe('mistralai/Voxtral-Mini-4B-Realtime-2602');
    expect(received[1].final).toBeUndefined();
    expect(Buffer.from(received[2].audio!, 'base64')).toEqual(Buffer.from(first));
    expect(Buffer.from(received[3].audio!, 'base64')).toEqual(Buffer.from(second));
    expect(received[4].final).toBe(true);
    expect(rec.transcripts()).toEqual([
      { type: 'transcript', text: 'Die', final: false },
      { type: 'transcript', text: 'Die hond', final: false },
      { type: 'transcript', text: 'Die hond.', final: true },
    ]);
  });

  test('a finish before the session starts still sends the audio and the final commit', async () => {
    const rec = recorder();
    const session = new RealtimeSttSession(config(), rec.emit, rec.close);

    session.pushAudio(audio(3_200));
    session.finish();
    await waitFor(() => rec.state.closed);

    expect(received.map((m) => m.type)).toEqual([
      'session.update',
      'input_audio_buffer.commit',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    expect(rec.transcripts().at(-1)).toEqual({
      type: 'transcript',
      text: 'Die hond.',
      final: true,
    });
  });

  test('passes an upstream error on and closes', async () => {
    failAppends = true;
    const rec = recorder();
    const session = new RealtimeSttSession(config(), rec.emit, rec.close);

    session.pushAudio(audio(3_200));
    await waitFor(() => rec.state.closed);

    expect(rec.state.messages.at(-1)).toEqual({ type: 'error', error: 'model overloaded' });
  });

  test('reports an unreachable endpoint', async () => {
    const rec = recorder();
    new RealtimeSttSession({ ...config(), baseUrl: 'http://localhost:1' }, rec.emit, rec.close);

    await waitFor(() => rec.state.closed);

    expect(rec.state.messages).toEqual([
      {
        type: 'error',
        error: 'Cannot reach the speech recognizer at ws://localhost:1/v1/realtime',
      },
    ]);
  });
});
