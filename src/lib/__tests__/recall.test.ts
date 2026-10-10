import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  answerRecall,
  getRecallDailyCount,
  RecallError,
  RECALL_COUNT_KEY,
  startRecallToday,
} from '../recall';

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

describe('getRecallDailyCount', () => {
  test('defaults to 10', () => {
    expect(getRecallDailyCount()).toBe(10);
  });

  test('reads a stored count', () => {
    store.set(RECALL_COUNT_KEY, '15');
    expect(getRecallDailyCount()).toBe(15);
  });

  test.each(['0', '31', '2.5', 'many'])('ignores %s', (value) => {
    store.set(RECALL_COUNT_KEY, value);
    expect(getRecallDailyCount()).toBe(10);
  });
});

describe('recall requests', () => {
  test('send the count and the active language', async () => {
    const fetchMock = vi.fn(async () => Response.json({ day: '2026-10-10', items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await startRecallToday(15);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/recall\/today\?language=\w+$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ count: 15 });
  });

  test('turn an error response into a RecallError with its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Save at least 5 words', code: 'NOT_ENOUGH_VOCAB' },
          { status: 400 },
        ),
      ),
    );

    const error = await startRecallToday(10).catch((e) => e);
    expect(error).toBeInstanceOf(RecallError);
    expect(error).toMatchObject({ message: 'Save at least 5 words', code: 'NOT_ENOUGH_VOCAB' });
  });

  test('send a give-up as an empty answer', async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);

    await answerRecall('2026-10-10', 3, '', true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/recall/2026-10-10/3/answer');
    expect(JSON.parse(String(init.body))).toEqual({ answer: '', giveUp: true });
  });
});
