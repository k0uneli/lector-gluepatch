import '../test-guard';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { websocket } from 'hono/bun';
import { db } from '../db';
import { makeSttRoutes } from './stt';

const STT_KEYS = ['sttSource', 'sttProtocol', 'sttUrl', 'sttModel', 'sttApiKey'];

function setLocal(key: string, value: unknown) {
  db.prepare("INSERT OR REPLACE INTO settings (userId, key, value) VALUES ('local', ?, ?)").run(
    key,
    JSON.stringify(value),
  );
}

let lastLanguage: FormDataEntryValue | null = null;
const whisper = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/v1/models') return Response.json({ data: [] });
    if (path === '/v1/audio/transcriptions') {
      lastLanguage = (await req.formData()).get('language');
      return Response.json({ text: 'Goeie môre' });
    }
    return new Response('not found', { status: 404 });
  },
});

const savedAsrUrl = process.env.ASR_URL;

afterAll(() => whisper.stop(true));
afterEach(() => {
  db.prepare(
    `DELETE FROM settings WHERE userId = 'local' AND key IN (${STT_KEYS.map(() => '?').join(', ')})`,
  ).run(...STT_KEYS);
  if (savedAsrUrl === undefined) delete process.env.ASR_URL;
  else process.env.ASR_URL = savedAsrUrl;
});

function useCustomWhisper() {
  setLocal('sttSource', 'custom');
  setLocal('sttProtocol', 'http');
  setLocal('sttUrl', `http://localhost:${whisper.port}/v1`);
  setLocal('sttModel', 'whisper-1');
}

describe('speech recognition routes', () => {
  test('cloud answers 404 for the status and the stream', async () => {
    const app = makeSttRoutes('cloud');

    const status = await app.request('/status');
    expect(status.status).toBe(404);
    expect(await status.json()).toEqual({ error: 'Not found' });

    const stream = await app.request('/stream', { headers: { Upgrade: 'websocket' } });
    expect(stream.status).toBe(404);
  });

  test('status reports a reachable custom endpoint', async () => {
    useCustomWhisper();

    const response = await makeSttRoutes('selfhost').request('/status');

    expect(await response.json()).toEqual({
      source: 'custom',
      protocol: 'http',
      model: 'whisper-1',
      endpoint: `http://localhost:${whisper.port}`,
      ok: true,
    });
  });

  test('status reports the audio-import ASR server as the default', async () => {
    process.env.ASR_URL = `http://localhost:${whisper.port}`;

    const body = await (await makeSttRoutes('selfhost').request('/status')).json();

    expect(body.source).toBe('asr');
    expect(body.protocol).toBe('http');
    expect(body.ok).toBe(true);
  });

  test('status reports an unreachable endpoint and a missing one', async () => {
    setLocal('sttSource', 'custom');
    const missing = await (await makeSttRoutes('selfhost').request('/status')).json();
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe('No endpoint set');

    setLocal('sttUrl', 'http://localhost:1');
    const unreachable = await (await makeSttRoutes('selfhost').request('/status')).json();
    expect(unreachable.ok).toBe(false);
    expect(unreachable.error).toBe('Cannot reach http://localhost:1');
  });

  test('streams transcripts over a WebSocket until the client stops', async () => {
    useCustomWhisper();
    const server = Bun.serve({ port: 0, fetch: makeSttRoutes('selfhost').fetch, websocket });

    try {
      const messages: { type: string; text?: string; final?: boolean }[] = [];
      const client = new WebSocket(`ws://localhost:${server.port}/stream?language=af`);
      const closed = new Promise<void>((resolve) =>
        client.addEventListener('close', () => resolve()),
      );
      client.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve) => client.addEventListener('open', () => resolve()));

      client.send(new Uint8Array(16_000));
      const deadline = Date.now() + 4_000;
      while (!messages.some((m) => m.type === 'transcript') && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      client.send(JSON.stringify({ type: 'stop' }));
      await closed;

      expect(messages[0]).toEqual({ type: 'ready' });
      expect(messages).toContainEqual({ type: 'transcript', text: 'Goeie môre', final: false });
      expect(messages.at(-1)).toEqual({ type: 'transcript', text: 'Goeie môre', final: true });
      expect(lastLanguage).toBe('af');
    } finally {
      server.stop(true);
    }
  });
});
