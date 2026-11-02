import { db } from '../../db';
import type { LectorMode } from '../config';
import type { LanguageConfig } from '../languages';
import {
  PODCAST_ENGINES,
  PODCAST_EXPLAIN_LEVELS,
  PODCAST_MAX_SLOW_TEMPO,
  PODCAST_MIN_SLOW_TEMPO,
} from '../settings-keys';
import { DEFAULT_EXPLAIN_BELOW, type ExplainBelow } from './script';

export { PODCAST_ENGINES };
export type PodcastEngineId = (typeof PODCAST_ENGINES)[number];

export const DEFAULT_GOOGLE_PERSONA = 'Aoede';
export const DEFAULT_ELEVEN_MODEL = 'eleven_multilingual_v2';
export const DEFAULT_SLOW_TEMPO = 0.75;

export interface PodcastSettings {
  engine: PodcastEngineId | null;
  /** Chirp 3 HD persona name. Empty means the pack's standard voice. */
  googlePersona: string;
  /** The rest come from the server env, not account settings. */
  localUrl: string;
  localModel: string;
  /** The voice the local server reads target-language text with. */
  localVoice: string;
  localEnglishVoice: string;
  localApiKey: string;
  elevenApiKey: string;
  elevenVoiceId: string;
  elevenModel: string;
  slowTempo: number;
  explainBelow: ExplainBelow;
}

function readSetting(userId: string, key: string): unknown {
  const row = db
    .prepare('SELECT value FROM settings WHERE userId = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export function readPodcastSettings(userId: string): PodcastSettings {
  const engine = readSetting(userId, 'podcastEngine');
  const tempo = Number(readSetting(userId, 'podcastSlowTempo'));
  const explainBelow = readSetting(userId, 'podcastExplainBelow');
  const persona = readSetting(userId, 'podcastGoogleVoice');
  return {
    engine: (PODCAST_ENGINES as readonly unknown[]).includes(engine)
      ? (engine as PodcastEngineId)
      : null,
    googlePersona: typeof persona === 'string' ? persona.trim() : DEFAULT_GOOGLE_PERSONA,
    localUrl: env('PODCAST_TTS_URL'),
    localModel: env('PODCAST_TTS_MODEL'),
    localVoice: env('PODCAST_TTS_VOICE'),
    localEnglishVoice: env('PODCAST_TTS_ENGLISH_VOICE'),
    localApiKey: env('PODCAST_TTS_API_KEY'),
    elevenApiKey: env('ELEVENLABS_API_KEY'),
    elevenVoiceId: env('ELEVENLABS_VOICE_ID'),
    elevenModel: env('ELEVENLABS_MODEL', DEFAULT_ELEVEN_MODEL),
    slowTempo:
      Number.isFinite(tempo) && tempo >= PODCAST_MIN_SLOW_TEMPO && tempo <= PODCAST_MAX_SLOW_TEMPO
        ? tempo
        : DEFAULT_SLOW_TEMPO,
    explainBelow: (PODCAST_EXPLAIN_LEVELS as readonly unknown[]).includes(explainBelow)
      ? (explainBelow as ExplainBelow)
      : DEFAULT_EXPLAIN_BELOW,
  };
}

export interface EngineStatus {
  configured: boolean;
  reason?: string;
}

/** Whether each engine can speak this language for this account. */
export function engineStatuses(
  settings: PodcastSettings,
  pack: LanguageConfig,
  mode: LectorMode,
): Record<PodcastEngineId, EngineStatus> {
  const selfhostOnly = { configured: false, reason: 'Available on self-hosted Lector only' };
  const audio = pack.pronunciation.audio;
  const hasGoogleVoice = audio !== 'none' && audio.includes('google') && !!pack.ttsCode;
  const google: EngineStatus = !hasGoogleVoice
    ? { configured: false, reason: `Google has no voice for ${pack.name}` }
    : !process.env.GOOGLE_CLOUD_API_KEY
      ? { configured: false, reason: 'Set GOOGLE_CLOUD_API_KEY on the server' }
      : { configured: true };
  if (mode !== 'selfhost') return { google, local: selfhostOnly, elevenlabs: selfhostOnly };
  const local: EngineStatus = !settings.localUrl
    ? { configured: false, reason: 'Set PODCAST_TTS_URL on the server' }
    : !settings.localVoice || !settings.localEnglishVoice
      ? {
          configured: false,
          reason: 'Set PODCAST_TTS_VOICE and PODCAST_TTS_ENGLISH_VOICE on the server',
        }
      : { configured: true };
  const elevenlabs: EngineStatus = !settings.elevenApiKey
    ? { configured: false, reason: 'Set ELEVENLABS_API_KEY on the server' }
    : !settings.elevenVoiceId
      ? { configured: false, reason: 'Set ELEVENLABS_VOICE_ID on the server' }
      : { configured: true };
  return { google, local, elevenlabs };
}

/** The engine to preselect: the saved choice when it works, else the first that does. */
export function defaultEngine(
  settings: PodcastSettings,
  statuses: Record<PodcastEngineId, EngineStatus>,
): PodcastEngineId | null {
  if (settings.engine && statuses[settings.engine].configured) return settings.engine;
  return PODCAST_ENGINES.find((id) => statuses[id].configured) ?? null;
}
