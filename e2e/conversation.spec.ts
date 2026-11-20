import { test, expect, Page, Route } from '@playwright/test';
import {
  clearRecognizer,
  FAKE_MICROPHONE,
  startRecognizerStub,
  sttUnreachable,
  useRecognizer,
} from './stt-helpers';

/**
 * The Conversation tab. /api/conversation/* is mocked because the e2e API has
 * no language model or voice engine; the server side is covered by
 * api/src/routes/conversation.test.ts. Speech input runs through the real
 * /api/stt/stream with a stub recognizer.
 *
 * Covers:
 *   - Happy path: nav link, a topic, the opening reply, a typed turn, English
 *   - Replies are read aloud by the chosen engine; Voice off stops that
 *   - A spoken turn is sent when the recognizer finishes
 *   - A failed reply can be retried; the conversation survives a reload
 *   - New conversation clears it; no voice engine means text only
 *   - The settings panel stores the slider, the voice and auto-play
 */

test.use(FAKE_MICROPHONE);

const REPLIES = [
  { reply: 'Hallo! Hoe gaan dit?', translation: 'Hello! How are you?', newPercent: 0, newWords: [] },
  {
    reply: 'Lekker! Wat eet jy vandag?',
    translation: 'Nice! What are you eating today?',
    newPercent: 20,
    newWords: ['lekker'],
  },
];

/** A short silent WAV, so the page has something it can play. */
function silentWav(): Buffer {
  const samples = 800;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

interface MockOptions {
  configured?: boolean;
  failFirst?: boolean;
}

async function mockConversation(page: Page, options: MockOptions = {}) {
  const seen = { replies: [] as Array<Record<string, any>>, speaks: [] as Array<Record<string, any>> };
  let fail = options.failFirst ?? false;
  await page.route('**/api/conversation/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/voices')) {
      const configured = options.configured ?? true;
      await route.fulfill({
        json: {
          engines: {
            google: configured ? { configured: true } : { configured: false, reason: 'No key' },
            local: { configured: false, reason: 'Set PODCAST_TTS_URL on the server' },
            elevenlabs: { configured: false, reason: 'Set ELEVENLABS_API_KEY on the server' },
          },
          defaultEngine: configured ? 'google' : null,
        },
      });
      return;
    }
    if (path.endsWith('/speak')) {
      seen.speaks.push(JSON.parse(request.postData() ?? '{}'));
      await route.fulfill({ body: silentWav(), contentType: 'audio/wav' });
      return;
    }
    const body = JSON.parse(request.postData() ?? '{}');
    seen.replies.push(body);
    if (fail) {
      fail = false;
      await route.fulfill({ status: 502, json: { error: 'Could not get a reply.' } });
      return;
    }
    const turn = REPLIES[Math.min(seen.replies.length - 1, REPLIES.length - 1)];
    await route.fulfill({ json: turn });
  });
  return seen;
}

async function startConversation(page: Page, topic = '') {
  await page.goto('/conversation');
  await expect(page.getByTestId('conversation-intro')).toBeVisible();
  if (topic) await page.getByTestId('conversation-topic').fill(topic);
  await page.getByTestId('conversation-start').click();
  await expect(page.getByTestId('conversation-reply').first()).toHaveText(REPLIES[0].reply);
}

test.describe('Conversation', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('conversation-test-init')) {
        localStorage.removeItem('lector-conversation:af');
        sessionStorage.setItem('conversation-test-init', '1');
      }
    });
  });

  test('happy path: open from the nav, start on a topic, reply by typing', async ({ page }) => {
    const seen = await mockConversation(page, { configured: false });
    await page.goto('/practice');
    await page.locator('aside').getByRole('link', { name: 'Conversation' }).click();
    await expect(page).toHaveURL(/\/conversation$/);
    await expect(page.getByTestId('conversation-intro')).toContainText('up to 3% new words');

    await page.getByTestId('conversation-topic').fill('food');
    await page.getByTestId('conversation-start').click();
    await expect(page.getByTestId('conversation-reply').first()).toHaveText(REPLIES[0].reply);
    expect(seen.replies[0]).toEqual({ history: [], newPercent: 3, topic: 'food' });
    await expect(page.getByTestId('conversation-topic-label')).toHaveText('Topic: food');

    await expect(page.getByTestId('conversation-send')).toBeDisabled();
    await page.getByTestId('conversation-input').fill('Goed dankie');
    await page.getByTestId('conversation-input').press('Enter');
    await expect(page.getByTestId('conversation-user')).toHaveText('Goed dankie');
    await expect(page.getByTestId('conversation-reply').nth(1)).toHaveText(REPLIES[1].reply);
    expect(seen.replies[1].history).toEqual([
      { role: 'assistant', text: REPLIES[0].reply },
      { role: 'user', text: 'Goed dankie' },
    ]);

    const second = page.getByTestId('conversation-partner').nth(1);
    await expect(second.getByTestId('conversation-new-percent')).toHaveText('20% new');
    await expect(second.getByTestId('conversation-new-percent')).toHaveAttribute(
      'title',
      'New: lekker',
    );
    await expect(second.getByTestId('conversation-translation')).toHaveCount(0);
    await second.getByTestId('conversation-toggle-translation').click();
    await expect(second.getByTestId('conversation-translation')).toHaveText(
      'Nice! What are you eating today?',
    );
    await expect(page.getByTestId('conversation-play')).toHaveCount(0);
    expect(seen.speaks).toEqual([]);
  });

  test('replies are read aloud by the chosen engine; Voice off stops that', async ({ page }) => {
    const seen = await mockConversation(page);
    await startConversation(page);
    await expect.poll(() => seen.speaks).toEqual([{ text: REPLIES[0].reply, engine: 'google' }]);

    await page.getByTestId('conversation-autoplay').click();
    await expect(page.getByTestId('conversation-autoplay')).toHaveText('Voice off');
    await page.getByTestId('conversation-input').fill('Goed');
    await page.getByTestId('conversation-send').click();
    await expect(page.getByTestId('conversation-reply').nth(1)).toBeVisible();
    expect(seen.speaks).toHaveLength(1);

    await page.getByTestId('conversation-play').nth(1).click();
    await expect.poll(() => seen.speaks.length).toBe(2);
    expect(seen.speaks[1]).toEqual({ text: REPLIES[1].reply, engine: 'google' });
  });

  test('a spoken turn is sent when the recognizer finishes', async ({ page }) => {
    test.skip(sttUnreachable, 'the containerised API cannot reach the host stub recognizer');
    const stub = await startRecognizerStub();
    try {
      await useRecognizer(page, stub.url);
      const seen = await mockConversation(page, { configured: false });
      await startConversation(page);
      stub.say(['Goed', 'Goed dankie']);
      await page.getByTestId('conversation-mic').click();
      await expect(page.getByTestId('conversation-input')).toHaveValue(/Goed/, { timeout: 10000 });
      await page.getByRole('button', { name: 'Stop listening' }).click();
      await expect(page.getByTestId('conversation-user')).toHaveText('Goed dankie', {
        timeout: 10000,
      });
      await expect.poll(() => seen.replies.length).toBe(2);
      expect(seen.replies[1].history.at(-1)).toEqual({ role: 'user', text: 'Goed dankie' });
    } finally {
      await clearRecognizer(page);
      await stub.close();
    }
  });

  test('a failed reply can be retried, and the conversation survives a reload', async ({
    page,
  }) => {
    await mockConversation(page, { configured: false });
    await startConversation(page);
    await page.unroute('**/api/conversation/**');
    await mockConversation(page, { configured: false, failFirst: true });

    await page.getByTestId('conversation-input').fill('Goed');
    await page.getByTestId('conversation-send').click();
    await expect(page.getByTestId('conversation-error')).toHaveText('Could not get a reply.');
    await page.getByTestId('conversation-retry').click();
    await expect(page.getByTestId('conversation-reply')).toHaveCount(2);
    await expect(page.getByTestId('conversation-error')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('conversation-reply')).toHaveCount(2);
    await expect(page.getByTestId('conversation-user')).toHaveText('Goed');
  });

  test('New conversation clears it', async ({ page }) => {
    await mockConversation(page, { configured: false });
    await startConversation(page);
    await page.getByTestId('conversation-new').click();
    await expect(page.getByTestId('conversation-intro')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('conversation-intro')).toBeVisible();
  });

  test('the settings panel stores the slider, the voice and auto-play', async ({ page }) => {
    await mockConversation(page);
    await page.goto('/settings');
    const panel = page.getByTestId('conversation-settings');
    await expect(panel.getByTestId('conversation-new-percent-value')).toHaveText('up to 3%');
    await panel.getByTestId('conversation-new-percent-slider').getByRole('slider').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(panel.getByTestId('conversation-new-percent-value')).toHaveText('up to 5%');
    await expect(panel.getByTestId('conversation-voice-google')).toBeChecked();
    await expect(panel.getByTestId('conversation-voice-local')).toBeDisabled();
    await expect(panel).toContainText('Set PODCAST_TTS_URL on the server');
    await panel.getByTestId('conversation-autoplay-setting').uncheck();
    expect(
      await page.evaluate(() => [
        localStorage.getItem('lector-conversation-new-percent'),
        localStorage.getItem('lector-conversation-autoplay'),
      ]),
    ).toEqual(['5', 'false']);

    const seen = await mockConversation(page);
    await page.goto('/conversation');
    await expect(page.getByTestId('conversation-intro')).toContainText('up to 5% new words');
    await page.getByTestId('conversation-start').click();
    await expect(page.getByTestId('conversation-reply').first()).toBeVisible();
    expect(seen.replies.at(-1)?.newPercent).toBe(5);
    expect(seen.speaks).toEqual([]);
  });

  test('the mobile bottom bar shows the short label', async ({ page }) => {
    await mockConversation(page, { configured: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/conversation');
    await expect(
      page.locator('nav.fixed').getByRole('link', { name: 'Talk', exact: true }),
    ).toBeVisible();
  });
});
