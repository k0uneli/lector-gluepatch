import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page } from '@playwright/test';
import { apiUrl } from './api';

export const FAKE_MICROPHONE = {
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
};

// The API calls the recognizer, and in the Docker pass it cannot reach a stub on this host.
export const sttUnreachable = !!process.env.E2E_EXTERNAL_SERVER;

const STT_KEYS = ['sttSource', 'sttProtocol', 'sttUrl', 'sttModel', 'sttApiKey'];

/** A Whisper-style recognizer that answers each request with the next line of its script. */
export async function startRecognizerStub() {
  let script: string[] = [];
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.url === '/v1/audio/transcriptions') {
      req.resume();
      req.on('end', () => {
        const text = script[Math.min(requests, script.length - 1)] ?? '';
        requests++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    say(lines: string[]) {
      script = lines;
      requests = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function useRecognizer(page: Page, url: string) {
  const res = await page.request.put(apiUrl('/api/settings'), {
    data: { sttSource: 'custom', sttProtocol: 'http', sttUrl: url, sttModel: 'whisper-1' },
  });
  expect(res.ok()).toBeTruthy();
}

export async function clearRecognizer(page: Page) {
  for (const key of STT_KEYS) await page.request.delete(apiUrl(`/api/settings/${key}`));
}
