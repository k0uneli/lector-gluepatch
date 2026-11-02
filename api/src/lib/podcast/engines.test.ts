import '../../test-guard';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getLanguageConfig } from '../languages';
import type { TtsCache, TtsCacheKey } from '../tts-cache';
import { createPodcastVoice, normalizeTtsBaseUrl, resetChirpFallbacks } from './engines';
import type { PodcastSettings } from './settings';

const ru = getLanguageConfig('ru');

const settings: PodcastSettings = {
  engine: null,
  googlePersona: 'Aoede',
  localUrl: 'http://gpu.lan:8004/v1/',
  localModel: 'chatterbox',
  localVoice: 'daria-ru',
  localEnglishVoice: 'daria-en',
  localApiKey: 'local-key',
  elevenApiKey: 'xi-key',
  elevenVoiceId: 'voice/1',
  elevenModel: 'eleven_multilingual_v2',
  slowTempo: 0.85,
  explainBelow: 'level3',
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, impl };
}

function memoryCache(): TtsCache & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    backend: 'disk',
    store,
    async get(key: TtsCacheKey) {
      return store.get(key.hash) ?? null;
    },
    async put(key: TtsCacheKey, bytes: Uint8Array) {
      store.set(key.hash, bytes);
    },
  };
}

const audioBytes = new Uint8Array([1, 2, 3]);
const previousKey = process.env.GOOGLE_CLOUD_API_KEY;

beforeEach(() => {
  process.env.GOOGLE_CLOUD_API_KEY = 'g-key';
  resetChirpFallbacks();
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.GOOGLE_CLOUD_API_KEY;
  else process.env.GOOGLE_CLOUD_API_KEY = previousKey;
});

describe('google voice', () => {
  test('uses the Chirp 3 HD persona for both languages, without rate or pitch', async () => {
    const { calls, impl } = fakeFetch(() =>
      Response.json({ audioContent: Buffer.from(audioBytes).toString('base64') }),
    );
    const voice = createPodcastVoice('local', 'google', settings, ru, {
      fetchImpl: impl,
      cache: memoryCache(),
    });
    expect(await voice.speak('Hello', 'en')).toEqual(audioBytes);
    await voice.speak('Привет', 'target');
    expect(calls.map((c) => c.body.voice)).toEqual([
      { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Aoede' },
      { languageCode: 'ru-RU', name: 'ru-RU-Chirp3-HD-Aoede' },
    ]);
    expect(calls[0].body.audioConfig).toEqual({ audioEncoding: 'MP3' });
    expect(calls[0].url).toContain('key=g-key');
  });

  test('falls back to the standard voice when Google rejects the Chirp voice', async () => {
    const standard = ru.ttsVoice!;
    const { calls, impl } = fakeFetch((call) =>
      String((call.body.voice as { name: string }).name).includes('Chirp3')
        ? Response.json({ error: { message: 'voice not found' } }, { status: 400 })
        : Response.json({ audioContent: Buffer.from(audioBytes).toString('base64') }),
    );
    const voice = createPodcastVoice('local', 'google', settings, ru, {
      fetchImpl: impl,
      cache: memoryCache(),
    });
    await voice.speak('Привет', 'target');
    await voice.speak('Пока', 'target');
    expect(calls.map((c) => (c.body.voice as { name: string }).name)).toEqual([
      'ru-RU-Chirp3-HD-Aoede',
      standard,
      standard,
    ]);
  });

  test('an empty persona means the standard voices', async () => {
    const { calls, impl } = fakeFetch(() =>
      Response.json({ audioContent: Buffer.from(audioBytes).toString('base64') }),
    );
    const voice = createPodcastVoice('local', 'google', { ...settings, googlePersona: '' }, ru, {
      fetchImpl: impl,
      cache: memoryCache(),
    });
    await voice.speak('Hello', 'en');
    expect((calls[0].body.voice as { name: string }).name).toBe('en-US-Standard-C');
  });
});

describe('elevenlabs voice', () => {
  test('posts to the voice with the key header and no language code for multilingual v2', async () => {
    const { calls, impl } = fakeFetch(() => new Response(audioBytes));
    const voice = createPodcastVoice('local', 'elevenlabs', settings, ru, {
      fetchImpl: impl,
      cache: memoryCache(),
    });
    expect(await voice.speak('Привет', 'target')).toEqual(audioBytes);
    expect(calls[0].url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=mp3_44100_128',
    );
    expect(calls[0].headers['xi-api-key']).toBe('xi-key');
    expect(calls[0].body).toEqual({ text: 'Привет', model_id: 'eleven_multilingual_v2' });
  });

  test('sends the language code to Flash models', async () => {
    const { calls, impl } = fakeFetch(() => new Response(audioBytes));
    const voice = createPodcastVoice(
      'local',
      'elevenlabs',
      { ...settings, elevenModel: 'eleven_flash_v2_5' },
      ru,
      { fetchImpl: impl, cache: memoryCache() },
    );
    await voice.speak('Hello', 'en');
    await voice.speak('Привет', 'target');
    expect(calls.map((c) => c.body.language_code)).toEqual(['en', 'ru']);
  });

  test('reports the API error', async () => {
    const { impl } = fakeFetch(() =>
      Response.json({ detail: { message: 'Invalid API key' } }, { status: 401 }),
    );
    const voice = createPodcastVoice('local', 'elevenlabs', settings, ru, {
      fetchImpl: impl,
      cache: memoryCache(),
    });
    await expect(voice.speak('Hi', 'en')).rejects.toThrow(
      'ElevenLabs returned 401: Invalid API key',
    );
  });
});

describe('local voice', () => {
  test('uses the OpenAI speech endpoint with one voice per language', async () => {
    const { calls, impl } = fakeFetch(() => new Response(audioBytes));
    const voice = createPodcastVoice('local', 'local', settings, ru, {
      fetchImpl: impl,
      cache: memoryCache(),
    });
    await voice.speak('Hello', 'en');
    await voice.speak('Привет', 'target');
    expect(calls.map((c) => c.url)).toEqual([
      'http://gpu.lan:8004/v1/audio/speech',
      'http://gpu.lan:8004/v1/audio/speech',
    ]);
    expect(calls.map((c) => c.body.voice)).toEqual(['daria-en', 'daria-ru']);
    expect(calls[0].body).toMatchObject({
      input: 'Hello',
      model: 'chatterbox',
      response_format: 'mp3',
    });
    expect(calls[0].headers.Authorization).toBe('Bearer local-key');
  });

  test('rejects an empty response', async () => {
    const { impl } = fakeFetch(() => new Response(new Uint8Array()));
    const voice = createPodcastVoice('local', 'local', settings, ru, {
      fetchImpl: impl,
      cache: memoryCache(),
    });
    await expect(voice.speak('Hello', 'en')).rejects.toThrow('returned no audio');
  });
});

test('a cached run is not synthesized again', async () => {
  const { calls, impl } = fakeFetch(() => new Response(audioBytes));
  const cache = memoryCache();
  const voice = createPodcastVoice('local', 'local', settings, ru, { fetchImpl: impl, cache });
  await voice.speak('Hello', 'en');
  await voice.speak('Hello', 'en');
  await voice.speak('Hello', 'target');
  expect(calls.length).toBe(2);
  expect(cache.store.size).toBe(2);
});

test('normalizeTtsBaseUrl strips the API path', () => {
  expect(normalizeTtsBaseUrl('http://gpu:8004/v1/audio/speech')).toBe('http://gpu:8004');
  expect(normalizeTtsBaseUrl(' http://gpu:8004// ')).toBe('http://gpu:8004');
});
