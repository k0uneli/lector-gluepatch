'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { LoaderCircle, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { lectorMode } from '@/lib/api-base';
import { getAllSettings, setSetting } from '@/lib/data-layer';
import {
  getPodcasts,
  PODCAST_ENGINE_LABELS,
  PODCAST_ENGINES,
  testPodcastEngine,
  type EngineStatus,
  type PodcastEngineId,
  type PodcastExplainBelow,
} from '@/lib/podcast';

/** Mirrors DEFAULT_GOOGLE_PERSONA and DEFAULT_SLOW_TEMPO in api/src/lib/podcast/settings.ts. */
const DEFAULT_PERSONA = 'Aoede';
const DEFAULT_TEMPO = 0.85;

const EXPLAIN_OPTIONS: Array<{ value: PodcastExplainBelow; label: string }> = [
  { value: 'level1', label: 'Only new words' },
  { value: 'level3', label: 'New words and words at learning level 1 or 2' },
  { value: 'known', label: 'Every word not marked known' },
];

const ENGINE_SETUP: Record<PodcastEngineId, string> = {
  google:
    'Uses GOOGLE_CLOUD_API_KEY, the key read-aloud uses. Chirp 3 HD voices sound the most natural; a language without one falls back to its standard voice.',
  local:
    'An OpenAI-compatible speech server, for example chatterbox-tts-api on your own GPU. Set PODCAST_TTS_URL, PODCAST_TTS_VOICE (the target-language voice) and PODCAST_TTS_ENGLISH_VOICE on the server.',
  elevenlabs:
    'Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID on the server. ELEVENLABS_MODEL picks the model; the default is eleven_multilingual_v2.',
};

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none';

const first = (value: number | readonly number[]) => (Array.isArray(value) ? value[0] : value);

async function playSamples(samples: Array<{ contentType: string; audioContent: string }>) {
  for (const sample of samples) {
    const audio = new Audio(`data:${sample.contentType};base64,${sample.audioContent}`);
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      void audio.play().catch(() => resolve());
    });
  }
}

export default function PodcastSettings() {
  const [engines, setEngines] = useState<Record<PodcastEngineId, EngineStatus> | null>(null);
  const [engine, setEngine] = useState<PodcastEngineId | null>(null);
  const [persona, setPersona] = useState(DEFAULT_PERSONA);
  const [tempo, setTempo] = useState(DEFAULT_TEMPO);
  const [explainBelow, setExplainBelow] = useState<PodcastExplainBelow>('level3');
  const [testing, setTesting] = useState<PodcastEngineId | null>(null);
  const tempoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const load = async () => {
      const [settings, overview] = await Promise.all([
        getAllSettings().catch(() => ({}) as Record<string, unknown>),
        getPodcasts().catch(() => null),
      ]);
      if (overview) {
        setEngines(overview.engines);
        setEngine(overview.defaultEngine);
      }
      if (typeof settings.podcastGoogleVoice === 'string') setPersona(settings.podcastGoogleVoice);
      if (typeof settings.podcastSlowTempo === 'number') setTempo(settings.podcastSlowTempo);
      if (
        settings.podcastExplainBelow === 'level1' ||
        settings.podcastExplainBelow === 'level3' ||
        settings.podcastExplainBelow === 'known'
      ) {
        setExplainBelow(settings.podcastExplainBelow);
      }
    };
    void load();
  }, []);

  const save = (key: string, value: unknown) => {
    setSetting(key, value).catch((error) =>
      toast.error(error instanceof Error ? error.message : 'Failed to save setting'),
    );
  };

  const chooseEngine = (next: PodcastEngineId) => {
    setEngine(next);
    save('podcastEngine', next);
  };

  const test = async (id: PodcastEngineId) => {
    setTesting(id);
    try {
      await playSamples(await testPodcastEngine(id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The voice test failed');
    } finally {
      setTesting(null);
    }
  };

  return (
    <section className="panel space-y-5 p-6" data-testid="podcast-settings">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Podcast</h2>
        <p className="text-sm text-muted-foreground">
          How the Podcast tab reads chapters to you. The script uses the AI provider above.
        </p>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium text-foreground">Voice engine</p>
        {PODCAST_ENGINES.filter((id) => lectorMode() === 'selfhost' || id === 'google').map(
          (id) => {
            const status = engines?.[id];
            return (
              <div
                key={id}
                className="rounded-xl border border-border p-3"
                data-testid={`podcast-settings-${id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <input
                      type="radio"
                      name="podcast-engine"
                      checked={engine === id}
                      disabled={!status?.configured}
                      onChange={() => chooseEngine(id)}
                      data-testid={`podcast-settings-engine-${id}`}
                    />
                    {PODCAST_ENGINE_LABELS[id]}
                  </label>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs text-muted-foreground"
                      data-testid={`podcast-settings-status-${id}`}
                    >
                      {status ? (status.configured ? 'Ready' : status.reason) : 'Checking…'}
                    </span>
                    {status?.configured && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void test(id)}
                        disabled={testing !== null}
                        data-testid={`podcast-settings-test-${id}`}
                      >
                        {testing === id ? <LoaderCircle className="animate-spin" /> : <Play />}
                        Test voice
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{ENGINE_SETUP[id]}</p>
                {id === 'google' && (
                  <div className="mt-3">
                    <label
                      htmlFor="podcast-google-voice"
                      className="mb-1 block text-xs font-medium text-foreground"
                    >
                      Chirp 3 HD voice
                    </label>
                    <input
                      id="podcast-google-voice"
                      type="text"
                      value={persona}
                      maxLength={20}
                      onChange={(e) => setPersona(e.target.value)}
                      onBlur={() => save('podcastGoogleVoice', persona.trim())}
                      placeholder="Leave empty for the standard voices"
                      className={inputClass}
                      data-testid="podcast-google-voice"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      A voice name such as Aoede, Charon, Kore or Puck. The same voice reads English
                      and the target language.
                    </p>
                  </div>
                )}
              </div>
            );
          },
        )}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label id="podcast-tempo-label" className="text-sm font-medium text-foreground">
            Slow reading speed
          </label>
          <span className="text-sm text-muted-foreground" data-testid="podcast-tempo-value">
            {Math.round(tempo * 100)}%
          </span>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          How fast each sentence is read the first time. The paragraph at the end is read at normal
          speed. Changes apply to new paragraphs.
        </p>
        <Slider
          value={[tempo]}
          min={0.5}
          max={1}
          step={0.05}
          aria-labelledby="podcast-tempo-label"
          data-testid="podcast-tempo-slider"
          onValueChange={(value) => {
            const next = Math.round(first(value) * 100) / 100;
            setTempo(next);
            if (tempoTimer.current) clearTimeout(tempoTimer.current);
            tempoTimer.current = setTimeout(() => save('podcastSlowTempo', next), 400);
          }}
        />
      </div>

      <div>
        <label htmlFor="podcast-explain" className="mb-1 block text-sm font-medium text-foreground">
          Words to explain
        </label>
        <select
          id="podcast-explain"
          value={explainBelow}
          onChange={(e) => {
            const next = e.target.value as PodcastExplainBelow;
            setExplainBelow(next);
            save('podcastExplainBelow', next);
          }}
          className={inputClass}
          data-testid="podcast-explain"
        >
          {EXPLAIN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-muted-foreground">
          The narrator explains a word once per episode. Ignored words are never explained.
        </p>
      </div>
    </section>
  );
}
