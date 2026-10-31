import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getReadingNewPercent,
  getReadingWords,
  ReadingChallengeError,
  READING_NEW_PERCENT_KEY,
  READING_WORDS_KEY,
  startReadingChallenge,
} from '../reading-challenge';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading challenge settings', () => {
  test('default to 200 words and 5% new', () => {
    expect(getReadingWords()).toBe(200);
    expect(getReadingNewPercent()).toBe(5);
  });

  test('read stored values', () => {
    store.set(READING_WORDS_KEY, '450');
    store.set(READING_NEW_PERCENT_KEY, '0');
    expect(getReadingWords()).toBe(450);
    expect(getReadingNewPercent()).toBe(0);
  });

  test.each(['50', '601', '250.5', 'long', ''])('ignore a stored length of %p', (value) => {
    store.set(READING_WORDS_KEY, value);
    expect(getReadingWords()).toBe(200);
  });

  test.each(['-1', '21', 'lots'])('ignore a stored share of %p', (value) => {
    store.set(READING_NEW_PERCENT_KEY, value);
    expect(getReadingNewPercent()).toBe(5);
  });
});

describe('reading challenge requests', () => {
  test('send the settings and the active language', async () => {
    const fetchMock = vi.fn(async () => Response.json({ day: '2026-10-31', challenge: null }));
    vi.stubGlobal('fetch', fetchMock);

    await startReadingChallenge(300, 10);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/reading-challenge\/today\?language=\w+$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ words: 300, newPercent: 10 });
  });

  test('turn an error response into a ReadingChallengeError with its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Mark at least 30 words', code: 'NOT_ENOUGH_VOCAB' },
          { status: 400 },
        ),
      ),
    );

    const error = await startReadingChallenge(200, 5).catch((e) => e);
    expect(error).toBeInstanceOf(ReadingChallengeError);
    expect(error).toMatchObject({ message: 'Mark at least 30 words', code: 'NOT_ENOUGH_VOCAB' });
  });
});
