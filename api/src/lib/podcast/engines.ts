import { entitlements } from '../entitlements';
import type { LanguageConfig } from '../languages';
import { getTtsCache, ttsCacheKey, type TtsCache } from '../tts-cache';
import { GoogleTtsError, synthesizeWithGoogle } from '../tts/google';
import type { PodcastEngineId, PodcastSettings } from './settings';
import type { VoiceKind } from './text';

/** Speaks one run of text. Returns audio bytes in any container ffmpeg can decode. */
export interface PodcastVoice {
  speak(text: string, voice: VoiceKind): Promise<Uint8Array>;
}

/** A plan limit stopped the episode. Retrying the same paragraph cannot help. */
export class PodcastLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PodcastLimitError';
  }
}

const ENGLISH_GOOGLE_CODE = 'en-US';
const ENGLISH_STANDARD_VOICE = 'en-US-Standard-C';
const REQUEST_TIMEOUT_MS = 60_000;
/** A local GPU server can take a while on a long sentence. */
const LOCAL_TIMEOUT_MS = 180_000;
const ELEVEN_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

/** Locales whose Chirp 3 HD voice Google rejected; they use the standard voice instead. */
const chirpUnavailable = new Set<string>();

export function resetChirpFallbacks(): void {
  chirpUnavailable.clear();
}

function errorDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const { detail, error, message } = body as Record<string, unknown>;
  const pick = (value: unknown): string =>
    typeof value === 'string'
      ? value
      : value &&
          typeof value === 'object' &&
          typeof (value as { message?: unknown }).message === 'string'
        ? (value as { message: string }).message
        : '';
  return pick(detail) || pick(error) || pick(message);
}

async function failure(engine: string, response: Response): Promise<Error> {
  const body = await response.json().catch(() => null);
  const detail = errorDetail(body);
  return new Error(`${engine} returned ${response.status}${detail ? `: ${detail}` : ''}`);
}

function googleVoice(
  userId: string,
  settings: PodcastSettings,
  pack: LanguageConfig,
  fetchImpl: typeof fetch,
): {
  identity(voice: VoiceKind): string;
  speak(text: string, voice: VoiceKind): Promise<Uint8Array>;
} {
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY ?? '';
  const locale = (voice: VoiceKind) => (voice === 'en' ? ENGLISH_GOOGLE_CODE : pack.ttsCode!);
  const standard = (voice: VoiceKind) => (voice === 'en' ? ENGLISH_STANDARD_VOICE : pack.ttsVoice!);
  const voiceName = (voice: VoiceKind) => {
    const code = locale(voice);
    return settings.googlePersona && !chirpUnavailable.has(code)
      ? `${code}-Chirp3-HD-${settings.googlePersona}`
      : standard(voice);
  };

  async function synthesize(text: string, voice: VoiceKind): Promise<string> {
    const name = voiceName(voice);
    try {
      return await synthesizeWithGoogle(
        { apiKey, text, languageCode: locale(voice), voiceName: name },
        fetchImpl,
      );
    } catch (err) {
      const chirp = name !== standard(voice);
      if (!(err instanceof GoogleTtsError) || err.status !== 400 || !chirp) throw err;
      chirpUnavailable.add(locale(voice));
      return synthesizeWithGoogle(
        { apiKey, text, languageCode: locale(voice), voiceName: standard(voice) },
        fetchImpl,
      );
    }
  }

  return {
    identity: (voice) => `google:${voiceName(voice)}`,
    async speak(text, voice) {
      const verdict = entitlements.reserve(userId, 'ttsCharsPerMonth', text.length);
      if (!verdict.allowed) {
        throw new PodcastLimitError('The monthly text-to-speech limit is reached.');
      }
      try {
        return new Uint8Array(Buffer.from(await synthesize(text, voice), 'base64'));
      } catch (err) {
        entitlements.refund(verdict.reservation);
        throw err;
      }
    },
  };
}

function supportsLanguageCode(model: string): boolean {
  return /flash|turbo/.test(model);
}

function elevenVoice(
  settings: PodcastSettings,
  pack: LanguageConfig,
  fetchImpl: typeof fetch,
): {
  identity(voice: VoiceKind): string;
  speak(text: string, voice: VoiceKind): Promise<Uint8Array>;
} {
  return {
    identity: () => `elevenlabs:${settings.elevenModel}:${settings.elevenVoiceId}`,
    async speak(text, voice) {
      const body: Record<string, string> = { text, model_id: settings.elevenModel };
      if (supportsLanguageCode(settings.elevenModel)) {
        body.language_code = voice === 'en' ? 'en' : pack.code;
      }
      const response = await fetchImpl(
        `${ELEVEN_TTS_URL}/${encodeURIComponent(settings.elevenVoiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': settings.elevenApiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw await failure('ElevenLabs', response);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** No trailing slash and no `/v1` suffix, so a pasted endpoint URL also works. */
export function normalizeTtsBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1(\/audio\/speech)?$/, '');
}

function localVoice(
  settings: PodcastSettings,
  fetchImpl: typeof fetch,
): {
  identity(voice: VoiceKind): string;
  speak(text: string, voice: VoiceKind): Promise<Uint8Array>;
} {
  const baseUrl = normalizeTtsBaseUrl(settings.localUrl);
  const voiceName = (voice: VoiceKind) =>
    voice === 'en' ? settings.localEnglishVoice : settings.localVoice;
  return {
    identity: (voice) => `local:${baseUrl}:${settings.localModel}:${voiceName(voice)}`,
    async speak(text, voice) {
      // OpenAI fields only: servers such as chatterbox-tts-api take the language from the voice.
      const body: Record<string, string> = {
        input: text,
        voice: voiceName(voice),
        response_format: 'mp3',
      };
      if (settings.localModel) body.model = settings.localModel;
      const response = await fetchImpl(`${baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.localApiKey ? { Authorization: `Bearer ${settings.localApiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
      });
      if (!response.ok) throw await failure('The local TTS server', response);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** The engine's voice, with every run cached across episodes and users. */
export function createPodcastVoice(
  userId: string,
  engine: PodcastEngineId,
  settings: PodcastSettings,
  pack: LanguageConfig,
  deps: { fetchImpl?: typeof fetch; cache?: TtsCache } = {},
): PodcastVoice {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const cache = deps.cache ?? getTtsCache();
  const inner =
    engine === 'google'
      ? googleVoice(userId, settings, pack, fetchImpl as typeof fetch)
      : engine === 'elevenlabs'
        ? elevenVoice(settings, pack, fetchImpl as typeof fetch)
        : localVoice(settings, fetchImpl as typeof fetch);
  return {
    async speak(text, voice) {
      const key = ttsCacheKey({
        language: voice === 'en' ? 'en' : pack.code,
        voice: `podcast:${inner.identity(voice)}`,
        rate: 1,
        text,
      });
      const hit = await cache.get(key);
      if (hit) return hit;
      const bytes = await inner.speak(text, voice);
      if (bytes.byteLength === 0) throw new Error('The voice engine returned no audio');
      await cache.put(key, bytes);
      return bytes;
    },
  };
}
