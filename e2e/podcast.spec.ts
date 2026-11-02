import { test, expect, Page, Route } from '@playwright/test';
import { apiUrl } from './api';

/**
 * The Podcast tab (/podcast) and podcast lessons in the reader.
 *
 * The e2e API has no voice engine and no podcast worker, so generation is
 * served by a stateful mock of /api/podcasts. The real API runs the empty and
 * not-configured states, the estimate, and the books and chapters. Script,
 * audio, shows and the feed are covered by the API unit tests.
 *
 * Covers:
 *   - The tab sits below Practice, in the sidebar and the bottom bar
 *   - Real API: no engine set up, the worker-off notice, and the estimate
 *   - Happy path: chapter, range, estimate, generate, progress, ready, listen
 *   - A failed episode and its retry, deleting an episode, and the feed URL
 *   - Reader: a podcast lesson opens in listen-along with narration rows
 *   - Reader: the first paragraph arrives, then new paragraphs load in place
 */

const BOOK = 'E2E Podcast Boek';
const CHAPTER_TEXT = [
  'Die kat sit op die mat. Die hond slaap.',
  'Ons gaan more see toe.',
  'Die son skyn helder.',
].join('\n\n');

interface Episode {
  id: string;
  showId: string;
  lessonId: string;
  sourceLessonId: string;
  title: string;
  paraFrom: number;
  paraTo: number;
  paraDone: number;
  paraTotal: number;
  status: 'pending' | 'generating' | 'done' | 'error';
  error: string | null;
  engine: 'local';
  durationMs: number;
  createdAt: string;
  completedAt: string | null;
}

interface MockState {
  episodes: Episode[];
  hasToken: boolean;
  posts: Array<Record<string, unknown>>;
  retries: string[];
  deletes: string[];
}

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'ep-1',
    showId: 'show-1',
    lessonId: 'podcast-lesson-1',
    sourceLessonId: 'chapter',
    title: 'Hoofstuk 1',
    paraFrom: 1,
    paraTo: 3,
    paraDone: 0,
    paraTotal: 3,
    status: 'generating',
    error: null,
    engine: 'local',
    durationMs: 0,
    createdAt: '2026-11-02T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

/** Serve /api/podcasts from memory. Each list request advances generation by one paragraph. */
async function mockPodcasts(page: Page, initial: Partial<MockState> = {}): Promise<MockState> {
  const state: MockState = {
    episodes: [],
    hasToken: false,
    posts: [],
    retries: [],
    deletes: [],
    ...initial,
  };
  await page.route(
    (url) => url.pathname.startsWith('/api/podcasts'),
    async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/^\/api\/podcasts/, '');
      const method = request.method();
      const body = JSON.parse(request.postData() || '{}') as Record<string, unknown>;

      if (method === 'GET' && path === '') {
        for (const e of state.episodes) {
          if (e.status !== 'generating') continue;
          e.paraDone += 1;
          e.durationMs += 60_000;
          if (e.paraDone >= e.paraTotal) {
            e.status = 'done';
            e.completedAt = '2026-11-02T10:05:00.000Z';
          }
        }
        await route.fulfill({
          json: {
            workerEnabled: true,
            engines: {
              google: { configured: false, reason: 'Set GOOGLE_CLOUD_API_KEY on the server' },
              local: { configured: true },
              elevenlabs: { configured: false, reason: 'Set ELEVENLABS_API_KEY on the server' },
            },
            defaultEngine: 'local',
            feed: { available: true, hasToken: state.hasToken },
            shows:
              state.episodes.length === 0
                ? []
                : [
                    {
                      id: 'show-1',
                      collectionId: 'podcast-collection',
                      title: `${BOOK} · Podcast`,
                      author: 'Toets',
                      coverUrl: null,
                      episodes: state.episodes,
                    },
                  ],
          },
        });
        return;
      }
      if (method === 'POST' && path === '/estimate') {
        const from = (body.from as number | undefined) ?? 1;
        const to = (body.to as number | undefined) ?? 3;
        await route.fulfill({
          json: {
            paragraphCount: 3,
            from,
            to,
            paragraphs: to - from + 1,
            sentences: to - from + 2,
            unknownWords: 4,
            characters: 1800,
            minutes: 3,
            preview: { first: 'Die kat sit op die mat.', last: 'Die son skyn helder.' },
          },
        });
        return;
      }
      if (method === 'POST' && path === '') {
        state.posts.push(body);
        const from = body.from as number;
        const to = body.to as number;
        const created = episode({ paraFrom: from, paraTo: to, paraTotal: to - from + 1 });
        state.episodes.push(created);
        await route.fulfill({ status: 201, json: { episode: created } });
        return;
      }
      if (method === 'POST' && path === '/feed-token') {
        state.hasToken = true;
        await route.fulfill({ status: 201, json: { token: 'tok-123' } });
        return;
      }
      if (method === 'DELETE' && path === '/feed-token') {
        state.hasToken = false;
        await route.fulfill({ json: { success: true } });
        return;
      }
      const retry = path.match(/^\/([^/]+)\/retry$/);
      if (method === 'POST' && retry) {
        state.retries.push(retry[1]);
        const target = state.episodes.find((e) => e.id === retry[1])!;
        Object.assign(target, { status: 'generating', error: null });
        await route.fulfill({ json: { episode: target } });
        return;
      }
      const single = path.match(/^\/([^/]+)$/);
      if (method === 'DELETE' && single) {
        state.deletes.push(single[1]);
        state.episodes = state.episodes.filter((e) => e.id !== single[1]);
        await route.fulfill({ json: { success: true } });
        return;
      }
      await route.fulfill({ status: 404, json: { error: 'Not mocked' } });
    },
  );
  return state;
}

async function createBook(page: Page): Promise<{ collectionId: string; lessonId: string }> {
  const collection = await page.request.post(apiUrl('/api/collections'), {
    data: { title: BOOK, author: 'Toets', language: 'af' },
  });
  expect(collection.ok()).toBeTruthy();
  const { id: collectionId } = await collection.json();
  const lesson = await page.request.post(apiUrl(`/api/collections/${collectionId}/lessons`), {
    data: { title: 'Hoofstuk 1', textContent: CHAPTER_TEXT },
  });
  expect(lesson.ok()).toBeTruthy();
  const { id: lessonId } = await lesson.json();
  return { collectionId, lessonId };
}

async function cleanup(page: Page) {
  const res = await page.request.get(apiUrl('/api/collections?language=af'));
  for (const c of await res.json()) {
    if (typeof c.title === 'string' && c.title.startsWith('E2E Podcast')) {
      await page.request.delete(apiUrl(`/api/collections/${c.id}?language=af`));
    }
  }
}

async function chooseChapter(page: Page) {
  await page.getByTestId('podcast-collection').selectOption({ label: BOOK });
  await page.getByTestId('podcast-chapter').selectOption({ label: 'Hoofstuk 1' });
  await expect(page.getByTestId('podcast-estimate')).toBeVisible();
}

test.describe('Podcast tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await cleanup(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanup(page);
  });

  test('the tab sits directly below Practice, also in the bottom bar', async ({ page }) => {
    await mockPodcasts(page);
    await page.goto('/practice');
    const labels = await page.locator('aside').getByRole('link').allInnerTexts();
    const names = labels.map((l) => l.trim()).filter(Boolean);
    expect(names[names.indexOf('Practice') + 1]).toBe('Podcast');
    await page.locator('aside').getByRole('link', { name: 'Podcast', exact: true }).click();
    await expect(page).toHaveURL(/\/podcast$/);
    await expect(page.getByRole('heading', { name: 'Podcast', exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.locator('nav.fixed').getByRole('link', { name: 'Podcast', exact: true }),
    ).toBeVisible();
  });

  test('real API: without a voice engine nothing can be made, but the estimate works', async ({
    page,
  }) => {
    await createBook(page);
    await page.goto('/podcast');
    await expect(page.getByTestId('podcast-worker-off')).toContainText('PODCAST_WORKER=1');
    await expect(page.getByTestId('podcast-empty')).toBeVisible();
    await chooseChapter(page);
    await expect(page.getByTestId('podcast-estimate')).toContainText('3 paragraphs');
    await expect(page.getByTestId('podcast-no-engine')).toBeVisible();
    for (const id of ['google', 'local', 'elevenlabs']) {
      await expect(page.getByTestId(`podcast-engine-${id}`)).toBeDisabled();
    }
    await expect(page.getByTestId('podcast-generate')).toBeDisabled();
  });

  test('a library with no books points to the import', async ({ page }) => {
    await mockPodcasts(page);
    await page.route(
      (url) => url.pathname === '/api/collections',
      (route) => route.fulfill({ json: [] }),
    );
    await page.goto('/podcast');
    await expect(page.getByTestId('podcast-no-books')).toBeVisible();
    await expect(page.getByTestId('podcast-new')).toHaveCount(0);
  });

  test('happy path: pick a range, make the episode, watch it finish, listen', async ({ page }) => {
    const { lessonId } = await createBook(page);
    const state = await mockPodcasts(page);
    await page.goto('/podcast');
    await expect(page.getByTestId('podcast-empty')).toBeVisible();
    await chooseChapter(page);
    await expect(page.getByTestId('podcast-engine-local')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('podcast-engine-google')).toBeDisabled();

    await page.getByTestId('podcast-from').selectOption('2');
    await expect(page.getByTestId('podcast-estimate')).toContainText('2 paragraphs');
    await expect(page.getByTestId('podcast-to').locator('option')).toHaveText(['2', '3']);
    await page.getByTestId('podcast-generate').click();

    await expect(page.getByTestId('podcast-show-title')).toHaveText(`${BOOK} · Podcast`);
    expect(state.posts).toEqual([{ lessonId, from: 2, to: 3, engine: 'local' }]);
    const row = page.getByTestId('podcast-episode');
    await expect(row.getByRole('progressbar')).toBeVisible();
    await expect(row.getByTestId('podcast-episode-status')).toHaveText('Ready', { timeout: 15000 });
    await expect(row).toContainText('2 of 2 paragraphs');
    await expect(row.getByRole('progressbar')).toHaveCount(0);
    await expect(row.getByTestId('podcast-listen')).toHaveAttribute(
      'href',
      '/read/podcast-lesson-1',
    );
    await expect(row.getByTestId('podcast-download')).toHaveAttribute(
      'href',
      /\/api\/lessons\/podcast-lesson-1\/audio$/,
    );
  });

  test('a failed episode shows its error and can be retried', async ({ page }) => {
    const state = await mockPodcasts(page, {
      episodes: [
        episode({ status: 'error', paraDone: 1, error: 'The local TTS server returned 500' }),
      ],
    });
    await page.goto('/podcast');
    const row = page.getByTestId('podcast-episode');
    await expect(row.getByTestId('podcast-episode-error')).toHaveText(
      'The local TTS server returned 500',
    );
    await expect(row.getByTestId('podcast-listen')).toBeVisible();
    await row.getByTestId('podcast-retry').click();
    await expect(row.getByTestId('podcast-retry')).toHaveCount(0);
    expect(state.retries).toEqual(['ep-1']);
  });

  test('deleting an episode asks once more first', async ({ page }) => {
    const state = await mockPodcasts(page, {
      episodes: [episode({ status: 'done', paraDone: 3, durationMs: 180_000 })],
    });
    await page.goto('/podcast');
    await page.getByTestId('podcast-delete').click();
    await expect(page.getByTestId('podcast-delete')).toHaveText('Delete episode?');
    expect(state.deletes).toEqual([]);
    await page.getByTestId('podcast-delete').click();
    await expect(page.getByTestId('podcast-empty')).toBeVisible();
    expect(state.deletes).toEqual(['ep-1']);
  });

  test('the feed: turn it on, copy a book’s URL, turn it off', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockPodcasts(page, { episodes: [episode({ status: 'done', paraDone: 3 })] });
    await page.goto('/podcast');
    await expect(page.getByTestId('podcast-copy-feed')).toHaveCount(0);
    await page.getByTestId('podcast-feed-enable').click();
    await expect(page.getByTestId('podcast-feed-state')).toContainText('The feed is on.');
    await page.getByTestId('podcast-copy-feed').click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toMatch(/\/api\/podcasts\/feed\/tok-123\/show-1$/);
    await page.getByTestId('podcast-feed-disable').click();
    await expect(page.getByTestId('podcast-feed-enable')).toBeVisible();
    await expect(page.getByTestId('podcast-copy-feed')).toHaveCount(0);
  });
});

/** 16-bit mono PCM WAV of silence. */
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

const PARAGRAPH_1 = [
  { idx: 0, startMs: 0, endMs: 500, text: 'Paragraph 1.', lang: 'en' },
  { idx: 1, startMs: 500, endMs: 1500, text: 'Die kat sit op die mat.', lang: null },
  { idx: 2, startMs: 1500, endMs: 2500, text: 'The word «kat» means cat.', lang: 'en' },
  { idx: 3, startMs: 2500, endMs: 3500, text: 'Die hond slaap.', lang: null },
];
const PARAGRAPH_2 = [
  { idx: 4, startMs: 3500, endMs: 4000, text: 'Paragraph 2.', lang: 'en' },
  { idx: 5, startMs: 4000, endMs: 5000, text: 'Ons gaan more see toe.', lang: null },
];

interface ReaderState {
  status: 'generating' | 'done';
  segments: typeof PARAGRAPH_1;
  durationMs: number;
  paraDone: number;
  serverDurationMs: number;
}

/** Upload a real WAV, then serve it as a podcast lesson whose state the test controls. */
async function openPodcastLesson(page: Page, state: ReaderState): Promise<string> {
  const res = await page.request.post(apiUrl('/api/import/audio'), {
    multipart: {
      file: { name: 'episode.wav', mimeType: 'audio/wav', buffer: silentWav(6) },
      language: 'af',
      title: 'E2E Podcast Les',
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
        title: 'Hoofstuk 1',
        textContent: 'Die kat sit op die mat. Die hond slaap.\n\nOns gaan more see toe.',
        sourceType: 'podcast',
        sourceMeta: JSON.stringify({ episodeId: 'ep-reader', sourceLessonId: 'chapter' }),
        transcriptionStatus: state.status,
        transcriptionError: null,
        audioDurationMs: state.durationMs,
      },
    });
  });
  await page.route(`**/api/lessons/${lessonId}/segments**`, (route) =>
    route.fulfill({ json: state.segments }),
  );
  await page.route('**/api/podcasts/ep-reader?**', (route) =>
    route.fulfill({
      json: {
        episode: episode({
          id: 'ep-reader',
          lessonId,
          paraDone: state.paraDone,
          paraTotal: 2,
          status: state.status,
          durationMs: state.serverDurationMs,
        }),
      },
    }),
  );
  await page.goto(`/read/${lessonId}`);
  return lessonId;
}

test.describe('Podcast lessons in the reader', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await cleanup(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanup(page);
  });

  test('opens in listen-along; narration is plain except its «» words', async ({ page }) => {
    await openPodcastLesson(page, {
      status: 'done',
      segments: [...PARAGRAPH_1, ...PARAGRAPH_2],
      durationMs: 5000,
      paraDone: 2,
      serverDurationMs: 5000,
    });
    const rows = page.getByTestId('listen-segment');
    await expect(rows).toHaveCount(6);
    await expect(page.locator('[data-narration]')).toHaveCount(3);

    await expect(rows.nth(0).getByTestId('reader-word')).toHaveCount(0);
    await expect(rows.nth(1).getByTestId('reader-word')).toHaveCount(6);
    const note = rows.nth(2);
    await expect(note.getByTestId('reader-word')).toHaveText(['kat']);
    await expect(note).toHaveText('The word «kat» means cat.');
    await expect(page.getByTestId('podcast-progress')).toHaveCount(0);

    await note.getByTestId('reader-word').click();
    await expect(page.getByTestId('translation-drawer')).toBeVisible();
    await expect(page.getByTestId('translation-drawer')).toContainText('kat');
  });

  test('the first paragraph opens by itself and later ones load in place', async ({ page }) => {
    const state: ReaderState = {
      status: 'generating',
      segments: [],
      durationMs: 0,
      paraDone: 0,
      serverDurationMs: 0,
    };
    await openPodcastLesson(page, state);
    await expect(page.getByTestId('podcast-generating')).toBeVisible();

    Object.assign(state, {
      segments: PARAGRAPH_1,
      durationMs: 3500,
      paraDone: 1,
      serverDurationMs: 3500,
    });
    await expect(page.getByTestId('listen-segment')).toHaveCount(4, { timeout: 10000 });
    await expect(page.getByTestId('podcast-progress')).toContainText('1 of 2 paragraphs ready');
    await expect(page.getByTestId('podcast-load-new')).toHaveCount(0);

    state.serverDurationMs = 5000;
    state.paraDone = 2;
    await expect(page.getByTestId('podcast-load-new')).toBeVisible({ timeout: 10000 });
    Object.assign(state, { segments: [...PARAGRAPH_1, ...PARAGRAPH_2], durationMs: 5000 });
    await page.getByTestId('podcast-load-new').click();
    await expect(page.getByTestId('listen-segment')).toHaveCount(6);
    await expect(page.getByTestId('listen-audio')).toHaveAttribute('src', /\/audio\?v=5000$/);
  });
});
