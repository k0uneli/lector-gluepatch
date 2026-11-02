import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createPodcast,
  formatMinutes,
  paragraphChoices,
  PodcastError,
  podcastEpisodeIdOf,
  podcastFeedUrl,
} from '../podcast';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('podcastEpisodeIdOf', () => {
  test('reads the episode id of a podcast lesson', () => {
    expect(
      podcastEpisodeIdOf({
        sourceType: 'podcast',
        sourceMeta: JSON.stringify({ episodeId: 'ep-1', sourceLessonId: 'l-1' }),
      }),
    ).toBe('ep-1');
  });

  test('is null for other lessons and bad metadata', () => {
    expect(podcastEpisodeIdOf(null)).toBeNull();
    expect(
      podcastEpisodeIdOf({ sourceType: 'youtube', sourceMeta: '{"episodeId":"x"}' }),
    ).toBeNull();
    expect(podcastEpisodeIdOf({ sourceType: 'podcast', sourceMeta: 'not json' })).toBeNull();
    expect(podcastEpisodeIdOf({ sourceType: 'podcast', sourceMeta: '{"episodeId":7}' })).toBeNull();
  });
});

test('paragraphChoices lists 1 to the count', () => {
  expect(paragraphChoices(3)).toEqual([1, 2, 3]);
  expect(paragraphChoices(0)).toEqual([]);
});

test('formatMinutes', () => {
  expect(formatMinutes(12)).toBe('12 min');
  expect(formatMinutes(65)).toBe('1 h 05 min');
});

test('podcastFeedUrl escapes the token', () => {
  expect(podcastFeedUrl('a/b', 'show-1')).toMatch(/\/api\/podcasts\/feed\/a%2Fb\/show-1$/);
});

describe('createPodcast', () => {
  test('posts the range and engine with the active language', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ episode: { id: 'ep-1', status: 'pending' } }, { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const episode = await createPodcast({ lessonId: 'l-1', from: 2, to: 4, engine: 'local' });
    expect(episode.id).toBe('ep-1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/podcasts\?language=/);
    expect(JSON.parse(String(init.body))).toEqual({
      lessonId: 'l-1',
      from: 2,
      to: 4,
      engine: 'local',
    });
  });

  test('turns an error response into a PodcastError with its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Set PODCAST_TTS_URL on the server', code: 'ENGINE_NOT_CONFIGURED' },
          { status: 400 },
        ),
      ),
    );
    const failure = await createPodcast({ lessonId: 'l-1', engine: 'local' }).catch((e) => e);
    expect(failure).toBeInstanceOf(PodcastError);
    expect(failure).toMatchObject({
      message: 'Set PODCAST_TTS_URL on the server',
      code: 'ENGINE_NOT_CONFIGURED',
    });
  });

  test('names a plan limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'plan_limit', metric: 'maxLessons' }, { status: 429 }),
      ),
    );
    const failure = await createPodcast({ lessonId: 'l-1', engine: 'local' }).catch((e) => e);
    expect(failure).toMatchObject({ code: 'PLAN_LIMIT' });
  });
});
