import { test, expect, Page } from '@playwright/test';
import { apiUrl } from './api';

/**
 * Video lessons play through the same listen-along view as audio lessons.
 *
 * The lesson is uploaded as audio, then its GET is stubbed with an .mp4 path
 * and finished transcription, so the reader treats it as a video lesson. The
 * transcribe worker is off under e2e. Nothing here needs the media to play:
 * seeking and the shadow drill move the highlight from their own state.
 */

const SEGMENTS = [
  { idx: 0, startMs: 0, endMs: 2000, text: 'Goeie môre almal.' },
  { idx: 1, startMs: 2000, endMs: 4000, text: 'Welkom by die potgooi.' },
  { idx: 2, startMs: 4000, endMs: 6000, text: 'Tot volgende keer.' },
];

function silentWav(seconds: number): Buffer {
  const sampleRate = 8000;
  const dataSize = Math.round(sampleRate * seconds) * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function openVideoLesson(page: Page): Promise<string> {
  const res = await page.request.post(apiUrl('/api/import/audio'), {
    multipart: {
      file: { name: 'clip.wav', mimeType: 'audio/wav', buffer: silentWav(6.5) },
      language: 'af',
      title: 'E2E Video Lesson',
    },
  });
  expect(res.ok()).toBeTruthy();
  const { lessonId } = await res.json();

  await page.route(`**/api/lessons/${lessonId}`, async (route) => {
    const response = await route.fetch();
    const lesson = await response.json();
    await route.fulfill({
      response,
      json: {
        ...lesson,
        audioPath: `/app/data/audio/${lessonId}.mp4`,
        textContent: SEGMENTS.map((s) => s.text).join(' '),
        transcriptionStatus: 'done',
        transcriptionError: null,
        audioDurationMs: 6000,
      },
    });
  });
  await page.route(`**/api/lessons/${lessonId}/segments`, (route) =>
    route.fulfill({ json: SEGMENTS }),
  );
  await page.goto(`/read/${lessonId}`);
  return lessonId;
}

async function cleanup(page: Page) {
  const res = await page.request.get(apiUrl('/api/collections'));
  for (const c of await res.json()) {
    if (c.title?.startsWith('E2E Video')) {
      await page.request.delete(apiUrl(`/api/collections/${c.id}`));
    }
  }
}

test.describe('Video listen-along', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await cleanup(page);
  });
  test.afterEach(async ({ page }) => {
    await cleanup(page);
  });

  test('a video lesson opens in listen-along with the video above the transcript', async ({
    page,
  }) => {
    const lessonId = await openVideoLesson(page);

    const listen = page.getByTestId('listen-along');
    await expect(listen).toBeVisible({ timeout: 10000 });
    const video = page.getByTestId('listen-video');
    await expect(video).toBeVisible();
    expect(await video.getAttribute('src')).toContain(`/api/lessons/${lessonId}/video`);
    await expect(page.getByTestId('listen-audio')).toHaveCount(0);
    await expect(page.getByTestId('listen-segment')).toHaveCount(3);
    await expect(page.getByTestId('listen-scrubber')).toBeVisible();
  });

  test('row taps seek, and the shadow drill steps through sentences', async ({ page }) => {
    await openVideoLesson(page);
    const rows = page.getByTestId('listen-segment');
    await expect(rows).toHaveCount(3, { timeout: 10000 });

    await rows.nth(2).click({ position: { x: 6, y: 6 } });
    await expect(rows.nth(2)).toHaveAttribute('data-active-segment', 'true');

    await page.getByTestId('listen-mode-shadow').click();
    await expect(page.getByTestId('listen-progress')).toHaveText('Sentence 3 of 3');
    await page.getByTestId('listen-prev-sentence').click();
    await expect(page.getByTestId('listen-progress')).toHaveText('Sentence 2 of 3');
    await expect(rows.nth(1)).toHaveAttribute('data-active-segment', 'true');
  });

  test('dragging across words looks up the phrase', async ({ page }) => {
    const translated: Array<{ word: string; sentence: string }> = [];
    await page.route('**/api/translate', async (route) => {
      translated.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ json: { translation: 'good morning everyone' } });
    });
    await openVideoLesson(page);
    const row = page.getByTestId('listen-segment').first();
    await expect(row).toBeVisible({ timeout: 10000 });

    const words = row.getByTestId('reader-word');
    const from = (await words.nth(0).boundingBox())!;
    const to = (await words.nth(1).boundingBox())!;
    await page.mouse.move(from.x + 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect.poll(() => translated.length).toBe(1);
    expect(translated[0]).toMatchObject({ word: 'Goeie môre', sentence: 'Goeie môre almal.' });
    await expect(row.locator('[data-phrase-highlighted]')).toHaveCount(2);
  });

  test('the text view offers a way back to the video', async ({ page }) => {
    await openVideoLesson(page);
    await expect(page.getByTestId('listen-along')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('listen-along-exit').click();
    await expect(page.getByTestId('listen-along')).toHaveCount(0);
    await expect(page.getByText('Goeie môre almal.')).toBeVisible();

    const toggle = page.getByTestId('listen-along-toggle');
    await expect(toggle).toHaveAttribute('aria-label', 'Watch along');
    await toggle.click();
    await expect(page.getByTestId('listen-video')).toBeVisible();
  });
});
