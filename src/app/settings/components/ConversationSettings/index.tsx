'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { lectorMode } from '@/lib/api-base';
import {
  CONVERSATION_AUTOPLAY_KEY,
  CONVERSATION_MAX_NEW_PERCENT,
  CONVERSATION_MAX_PAUSE_SECONDS,
  CONVERSATION_MIN_PAUSE_SECONDS,
  CONVERSATION_NEW_PERCENT_KEY,
  CONVERSATION_PAUSE_KEY,
  CONVERSATION_PAUSE_STEP,
  CONVERSATION_STOP_MODE_KEY,
  CONVERSATION_VOICE_KEY,
  fetchConversationVoices,
  getConversationAutoplay,
  getConversationNewPercent,
  getConversationPauseSeconds,
  getConversationStopMode,
  pickEngine,
  type ConversationVoices,
  type ConversationStopMode,
} from '@/lib/conversation';
import { PODCAST_ENGINE_LABELS, PODCAST_ENGINES, type PodcastEngineId } from '@/lib/podcast';

const first = (value: number | readonly number[]) => (Array.isArray(value) ? value[0] : value);

export default function ConversationSettings() {
  const [newPercent, setNewPercent] = useState<number | null>(null);
  const [autoplay, setAutoplay] = useState(true);
  const [stopMode, setStopMode] = useState<ConversationStopMode>('auto');
  const [pauseSeconds, setPauseSeconds] = useState(2.5);
  const [voices, setVoices] = useState<ConversationVoices | null>(null);
  const [engine, setEngine] = useState<PodcastEngineId | null>(null);

  useEffect(() => {
    const load = () => {
      setNewPercent(getConversationNewPercent());
      setAutoplay(getConversationAutoplay());
      setPauseSeconds(getConversationPauseSeconds());
      setStopMode(getConversationStopMode());
    };
    load();
    let cancelled = false;
    fetchConversationVoices()
      .then((v) => {
        if (cancelled) return;
        setVoices(v);
        setEngine(pickEngine(v));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (newPercent === null) return null;
  const engines = PODCAST_ENGINES.filter((id) => lectorMode() === 'selfhost' || id === 'google');

  return (
    <section id="conversation" className="panel space-y-6 p-6" data-testid="conversation-settings">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Conversation</h2>
        <p className="text-sm text-muted-foreground">
          How your conversation partner talks. Replies use the AI provider above.
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label
            id="conversation-new-percent-label"
            className="text-sm font-medium text-foreground"
          >
            New vocabulary
          </label>
          <span
            className="text-sm text-muted-foreground"
            data-testid="conversation-new-percent-value"
          >
            up to {newPercent}%
          </span>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          The most a reply may use of words you have not marked. Speech is harder to follow than
          text, so the default is lower than for daily reading.
        </p>
        <Slider
          value={[newPercent]}
          min={0}
          max={CONVERSATION_MAX_NEW_PERCENT}
          step={1}
          aria-labelledby="conversation-new-percent-label"
          data-testid="conversation-new-percent-slider"
          onValueChange={(value) => {
            const next = first(value);
            setNewPercent(next);
            localStorage.setItem(CONVERSATION_NEW_PERCENT_KEY, String(next));
          }}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-foreground">Voice</legend>
        {engines.map((id) => {
          const status = voices?.engines[id];
          return (
            <label
              key={id}
              className="flex items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm"
            >
              <span className="flex items-center gap-2 font-medium text-foreground">
                <input
                  type="radio"
                  name="conversation-voice"
                  checked={engine === id}
                  disabled={!status?.configured}
                  onChange={() => {
                    setEngine(id);
                    localStorage.setItem(CONVERSATION_VOICE_KEY, id);
                  }}
                  data-testid={`conversation-voice-${id}`}
                />
                {PODCAST_ENGINE_LABELS[id]}
              </span>
              <span className="text-xs text-muted-foreground">
                {status ? (status.configured ? 'Ready' : status.reason) : 'Checking…'}
              </span>
            </label>
          );
        })}
        <p className="text-xs text-muted-foreground">
          The voices are the ones the Podcast settings use, for example the Chirp voice for Google
          or the voice that PODCAST_TTS_VOICE names for a local server such as Chatterbox.
        </p>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={autoplay}
          onChange={(e) => {
            setAutoplay(e.target.checked);
            localStorage.setItem(CONVERSATION_AUTOPLAY_KEY, String(e.target.checked));
          }}
          data-testid="conversation-autoplay-setting"
          className="h-4 w-4"
        />
        Read each reply aloud as it arrives
      </label>

      {lectorMode() === 'selfhost' && (
        <div>
          <p className="text-sm font-medium text-foreground">End of a spoken reply</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Stop automatically when you pause, or keep recording until you press stop. A turn can be
            up to two minutes long either way.
          </p>
          <div className="flex gap-2">
            {(
              [
                ['auto', 'Stop when I pause'],
                ['manual', 'I press stop'],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={mode}
                variant={stopMode === mode ? 'default' : 'secondary'}
                onClick={() => {
                  setStopMode(mode);
                  localStorage.setItem(CONVERSATION_STOP_MODE_KEY, mode);
                }}
                data-testid={`conversation-stop-${mode}`}
              >
                {label}
              </Button>
            ))}
          </div>
          {stopMode === 'auto' && (
            <div className="mt-4">
              <div className="flex items-baseline justify-between">
                <label
                  id="conversation-pause-label"
                  className="text-sm font-medium text-foreground"
                >
                  Pause length
                </label>
                <span
                  className="text-sm text-muted-foreground"
                  data-testid="conversation-pause-value"
                >
                  {pauseSeconds} s
                </span>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                How long you can stay silent before the recording stops. Raise it if it cuts you off
                while you think.
              </p>
              <Slider
                value={[pauseSeconds]}
                min={CONVERSATION_MIN_PAUSE_SECONDS}
                max={CONVERSATION_MAX_PAUSE_SECONDS}
                step={CONVERSATION_PAUSE_STEP}
                aria-labelledby="conversation-pause-label"
                data-testid="conversation-pause-slider"
                onValueChange={(value) => {
                  const next = first(value);
                  setPauseSeconds(next);
                  localStorage.setItem(CONVERSATION_PAUSE_KEY, String(next));
                }}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
