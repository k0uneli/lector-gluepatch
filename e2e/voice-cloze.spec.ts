import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { apiUrl } from './api';

// The API calls the recognizer from the server. In the Docker pass the API runs
// in a container, where 127.0.0.1 is not this machine, so specs that need the
// stub skip there.
const externalServer = !!process.env.E2E_EXTERNAL_SERVER;

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

const TEST_COLLECTION = 'top2000';
const CARD = {
  id: 'test-voice-cloze-1',
  sentence: 'Die bruin hond hardloop vinnig.',
  clozeWord: 'hardloop',
  clozeIndex: 3,
  translation: 'The brown dog runs fast.',
  source: 'tatoeba',
  collection: TEST_COLLECTION,
  masteryLevel: 25,
  nextReview: '2020-01-01T00:00:00.000Z',
  reviewCount: 3,
  timesCorrect: 2,
  timesIncorrect: 1,
};
const STT_KEYS = ['sttSource', 'sttProtocol', 'sttUrl', 'sttModel', 'sttApiKey'];

// A Whisper-style recognizer. Each request answers with the next line of
// `script`, so the transcript grows the way a re-transcribed clip does.
let script: string[] = [];
let requests = 0;
let recognizer: http.Server;
let recognizerUrl = '';

test.beforeAll(async () => {
  recognizer = http.createServer((req, res) => {
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
  await new Promise<void>((resolve) => recognizer.listen(0, '127.0.0.1', resolve));
  recognizerUrl = `http://127.0.0.1:${(recognizer.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => recognizer.close(() => resolve()));
});

async function useRecognizer(page: Page, url: string) {
  const res = await page.request.put(apiUrl('/api/settings'), {
    data: { sttSource: 'custom', sttProtocol: 'http', sttUrl: url, sttModel: 'whisper-1' },
  });
  expect(res.ok()).toBeTruthy();
}

async function clearRecognizer(page: Page) {
  for (const key of STT_KEYS) await page.request.delete(apiUrl(`/api/settings/${key}`));
}

async function seedCard(page: Page) {
  const due = await page.request.get(
    apiUrl(`/api/cloze/due?mode=review&collection=${TEST_COLLECTION}&limit=50`),
  );
  for (const s of await due.json()) await page.request.delete(apiUrl(`/api/cloze/${s.id}`));
  const res = await page.request.post(apiUrl('/api/cloze'), { data: [CARD] });
  expect(res.ok()).toBeTruthy();
}

async function masteryOf(page: Page): Promise<number> {
  const res = await page.request.get(apiUrl(`/api/cloze/${CARD.id}`));
  return (await res.json()).masteryLevel;
}

async function openSetup(page: Page) {
  await page.goto('/practice');
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30000 });
}

async function startVoiceReview(page: Page) {
  await openSetup(page);
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('button', { name: /1000-2000\s+\d+ due/ }).click();
  await expect(page.getByText('Say the missing word', { exact: true })).toBeVisible({
    timeout: 10000,
  });
}

async function speakOnce(page: Page, heard: string) {
  await page.getByRole('button', { name: 'Speak your answer' }).click();
  await expect(page.getByTestId('voice-transcript')).toContainText(heard, { timeout: 10000 });
  await page.getByRole('button', { name: 'Stop listening' }).click();
}

test.describe.serial('Voice cloze', () => {
  test.beforeEach(async ({ page }) => {
    script = [];
    requests = 0;
    await seedCard(page);
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(apiUrl(`/api/cloze/${CARD.id}`));
    await clearRecognizer(page);
  });

  test('shows each word as it is heard and accepts the missing word', async ({ page }) => {
    test.skip(externalServer, 'the containerised API cannot reach the host stub recognizer');
    script = ['Die', 'Die bruin', 'Die bruin hond', 'Die bruin hond hardloop'];
    await useRecognizer(page, recognizerUrl);
    await startVoiceReview(page);

    await page.getByTestId('voice-transcript').evaluate((el) => {
      const seen: string[] = [];
      (window as unknown as { __voiceSeen: string[] }).__voiceSeen = seen;
      new MutationObserver(() => {
        const text = el.textContent ?? '';
        if (text && seen.at(-1) !== text) seen.push(text);
      }).observe(el, { childList: true, subtree: true, characterData: true });
    });

    await page.getByRole('button', { name: 'Speak your answer' }).click();

    await expect(page.getByRole('button', { name: 'Next Sentence' })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole('heading', { name: 'Correct!' })).toBeVisible();
    const seen = await page.evaluate(
      () => (window as unknown as { __voiceSeen: string[] }).__voiceSeen,
    );
    expect(seen).toEqual(['Die', 'Die bruin', 'Die bruin hond', 'Die bruin hond hardloop']);
    expect(await masteryOf(page)).toBe(50);
  });

  test('allows three heard attempts, then records a miss', async ({ page }) => {
    test.skip(externalServer, 'the containerised API cannot reach the host stub recognizer');
    script = ['Die bruin hond loop vinnig'];
    await useRecognizer(page, recognizerUrl);
    await startVoiceReview(page);

    await speakOnce(page, 'loop');
    await expect(page.getByTestId('voice-message')).toHaveText('Not quite. 2 tries left.');
    await speakOnce(page, 'loop');
    await expect(page.getByTestId('voice-message')).toHaveText('Not quite. 1 try left.');
    await speakOnce(page, 'loop');

    await expect(page.getByRole('button', { name: 'Next Sentence' })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole('heading', { name: 'Incorrect' })).toBeVisible();
    expect(await masteryOf(page)).toBe(0);
  });

  test('an empty transcript does not use up an attempt', async ({ page }) => {
    test.skip(externalServer, 'the containerised API cannot reach the host stub recognizer');
    script = [''];
    await useRecognizer(page, recognizerUrl);
    await startVoiceReview(page);

    await page.getByRole('button', { name: 'Speak your answer' }).click();
    await page.getByRole('button', { name: 'Stop listening' }).click();

    await expect(page.getByTestId('voice-message')).toHaveText("Didn't catch that. Try again.");
    await expect(page.getByRole('button', { name: 'Speak your answer' })).toBeEnabled();
  });

  test('explains an unreachable recognizer and links to its settings', async ({ page }) => {
    await useRecognizer(page, 'http://127.0.0.1:1');
    await startVoiceReview(page);

    await page.getByRole('button', { name: 'Speak your answer' }).click();

    const alert = page.getByTestId('voice-message');
    await expect(alert).toHaveAttribute('role', 'alert', { timeout: 10000 });
    await expect(alert).toContainText('Cannot reach the speech recognizer at http://127.0.0.1:1', {
      timeout: 10000,
    });
    await expect(alert.getByRole('link', { name: 'Voice Recognition settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    await expect(page.getByRole('button', { name: 'Speak your answer' })).toBeEnabled();
  });

  test('Type instead switches this question to typing', async ({ page }) => {
    await startVoiceReview(page);

    await page.getByRole('button', { name: 'Type instead' }).click();
    const input = page.locator('input[placeholder="..."]');
    await expect(input).toBeFocused();
    await input.fill('hardloop');
    await input.press('Enter');

    await expect(page.getByRole('button', { name: 'Next Sentence' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Correct!' })).toBeVisible();
    expect(await masteryOf(page)).toBe(50);
  });

  test('Give up reveals the answer and counts a miss', async ({ page }) => {
    await startVoiceReview(page);

    await page.getByRole('button', { name: 'Give up' }).click();

    await expect(page.getByRole('button', { name: 'Next Sentence' })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole('heading', { name: 'Incorrect' })).toBeVisible();
    expect(await masteryOf(page)).toBe(0);
  });

  test('the chosen Voice mode is remembered', async ({ page }) => {
    await openSetup(page);
    await page.getByRole('button', { name: 'Voice', exact: true }).click();

    await openSetup(page);
    await page.getByRole('button', { name: /1000-2000\s+\d+ due/ }).click();

    await expect(page.getByText('Say the missing word', { exact: true })).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe.serial('Voice recognition settings', () => {
  test.afterEach(async ({ page }) => {
    await clearRecognizer(page);
  });

  test('defaults to the audio import model', async ({ page }) => {
    await page.goto('/settings');

    const panel = page.getByTestId('stt-settings');
    await expect(panel.getByRole('heading', { name: 'Voice Recognition' })).toBeVisible();
    await expect(panel.getByTestId('stt-asr-note')).toContainText(
      'transcribes imported audio lessons',
    );
    await expect(panel.getByTestId('stt-custom')).toHaveCount(0);
  });

  test('saves a custom endpoint and reports it connected', async ({ page }) => {
    test.skip(externalServer, 'the containerised API cannot reach the host stub recognizer');
    await page.goto('/settings');
    const panel = page.getByTestId('stt-settings');

    await panel.getByTestId('stt-source-custom').click();
    await panel.getByTestId('stt-protocol').selectOption('http');
    await panel.getByTestId('stt-endpoint').fill(recognizerUrl);
    await panel.getByTestId('stt-endpoint').press('Enter');
    await panel.getByTestId('stt-model').fill('whisper-1');
    await panel.getByTestId('stt-model').press('Enter');
    await panel.getByTestId('stt-api-key').fill('stt-secret');
    await panel.getByRole('button', { name: 'Save' }).click();

    await expect(panel.getByTestId('stt-api-key-status')).toHaveText('Configured');
    await expect(panel.getByTestId('stt-status')).toHaveText('Connected');

    await page.reload();
    await expect(panel.getByTestId('stt-endpoint')).toHaveValue(recognizerUrl);
    await expect(panel.getByTestId('stt-protocol')).toHaveValue('http');
    await expect(panel.getByTestId('stt-model')).toHaveValue('whisper-1');
    await expect(panel.getByTestId('stt-api-key-status')).toHaveText('Configured');

    const stored = await page.request.get(apiUrl('/api/settings/sttApiKey'));
    expect(await stored.json()).toBe(true);
  });

  test('rejects an endpoint that is not an http(s) URL', async ({ page }) => {
    await page.goto('/settings');
    const panel = page.getByTestId('stt-settings');

    await panel.getByTestId('stt-source-custom').click();
    await panel.getByTestId('stt-endpoint').fill('ws://localhost:8000');
    await panel.getByTestId('stt-endpoint').press('Enter');

    await expect(page.getByText('sttUrl must be a valid http(s) URL')).toBeVisible();
    const stored = await page.request.get(apiUrl('/api/settings/sttUrl'));
    expect(await stored.json()).toBeNull();
  });
});
