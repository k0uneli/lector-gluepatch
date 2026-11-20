'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { LoaderCircle, RotateCcw, Send, Volume2, VolumeX } from 'lucide-react';
import MicButton from '@/components/MicButton';
import PageHeader from '@/components/PageHeader';
import TargetText from '@/components/TargetText';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { lectorMode } from '@/lib/api-base';
import {
  CONVERSATION_AUTOPLAY_KEY,
  CONVERSATION_MAX_MESSAGE_LENGTH,
  ConversationError,
  fetchConversationVoices,
  getConversationAutoplay,
  getConversationNewPercent,
  loadConversation,
  pickEngine,
  requestReply,
  saveConversation,
  speakReply,
  type ConversationMessage,
  type ConversationVoices,
} from '@/lib/conversation';
import { PODCAST_ENGINE_LABELS, type PodcastEngineId } from '@/lib/podcast';
import { isVoiceInputSupported } from '@/lib/stt';
import { useSpeechCapture } from '@/lib/stt/use-speech-capture';
import { useActiveLanguage } from '@/utils/hooks';

export default function ConversationPage() {
  const pack = useActiveLanguage();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [topic, setTopic] = useState('');
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<ConversationError | null>(null);
  const [newPercent, setNewPercent] = useState(3);
  const [voices, setVoices] = useState<ConversationVoices | null>(null);
  const [engine, setEngine] = useState<PodcastEngineId | null>(null);
  const [autoplay, setAutoplay] = useState(true);
  const [voiceInput, setVoiceInput] = useState(false);
  const [playing, setPlaying] = useState<number | null>(null);
  const [shownTranslations, setShownTranslations] = useState<Set<number>>(new Set());
  const [heardNothing, setHeardNothing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrls = useRef(new Map<string, string>());
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const load = () => {
      const saved = loadConversation(pack.code);
      setMessages(saved?.messages ?? []);
      setTopic(saved?.topic ?? '');
      setError(null);
      setShownTranslations(new Set());
      setNewPercent(getConversationNewPercent());
      setAutoplay(getConversationAutoplay());
      setVoiceInput(lectorMode() === 'selfhost' && isVoiceInputSupported());
    };
    load();
    let cancelled = false;
    fetchConversationVoices()
      .then((v) => {
        if (cancelled) return;
        setVoices(v);
        setEngine(pickEngine(v));
      })
      .catch(() => {
        if (!cancelled) setEngine(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pack.code]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, thinking]);

  useEffect(() => {
    const urls = audioUrls.current;
    return () => {
      audioRef.current?.pause();
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const stopAudio = () => {
    audioRef.current?.pause();
    setPlaying(null);
  };

  const play = useCallback(
    async (index: number, text: string) => {
      if (!engine) return;
      audioRef.current?.pause();
      setPlaying(index);
      try {
        const key = `${engine}:${text}`;
        let url = audioUrls.current.get(key);
        if (!url) {
          url = URL.createObjectURL(await speakReply(text, engine));
          audioUrls.current.set(key, url);
        }
        const audio = audioRef.current ?? new Audio();
        audioRef.current = audio;
        audio.src = url;
        audio.onended = () => setPlaying((p) => (p === index ? null : p));
        await audio.play();
      } catch (err) {
        setPlaying(null);
        setError(
          err instanceof ConversationError
            ? err
            : new ConversationError('The reply could not be played.'),
        );
      }
    },
    [engine],
  );

  const commit = (next: ConversationMessage[], nextTopic = topic) => {
    setMessages(next);
    saveConversation(pack.code, next.length > 0 ? { topic: nextTopic, messages: next } : null);
  };

  const respond = async (history: ConversationMessage[]) => {
    setThinking(true);
    setError(null);
    try {
      const reply = await requestReply(history, newPercent, topic.trim());
      const next = [...history, { role: 'assistant' as const, ...reply }];
      commit(next);
      if (autoplay && engine) void play(next.length - 1, reply.text);
    } catch (err) {
      setError(err instanceof ConversationError ? err : new ConversationError(String(err)));
    } finally {
      setThinking(false);
    }
  };

  const send = (text: string) => {
    const trimmed = text.trim().slice(0, CONVERSATION_MAX_MESSAGE_LENGTH);
    if (!trimmed || thinking) return;
    const next = [...messages, { role: 'user' as const, text: trimmed }];
    commit(next);
    setDraft('');
    void respond(next);
  };

  const speech = useSpeechCapture(pack.code, (transcript) => {
    setHeardNothing(!transcript.trim());
    send(transcript);
  });

  const startOver = () => {
    speech.cancel();
    stopAudio();
    commit([]);
    setShownTranslations(new Set());
    setError(null);
  };

  const toggleAutoplay = () => {
    const next = !autoplay;
    setAutoplay(next);
    localStorage.setItem(CONVERSATION_AUTOPLAY_KEY, String(next));
    if (!next) stopAudio();
  };

  const toggleTranslation = (index: number) =>
    setShownTranslations((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const started = messages.length > 0;
  const lastIsUser = messages.at(-1)?.role === 'user';
  const listening = speech.phase === 'listening' || speech.phase === 'finishing';

  return (
    <main className="mx-auto flex max-w-3xl flex-col px-4 py-8 pb-28 sm:px-6 sm:pb-8 lg:px-8">
      <PageHeader title="Conversation">
        {started && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleAutoplay}
              disabled={!engine}
              aria-pressed={autoplay}
              data-testid="conversation-autoplay"
              title={engine ? undefined : 'No voice engine is set up'}
            >
              {autoplay && engine ? <Volume2 /> : <VolumeX />}
              {autoplay && engine ? 'Voice on' : 'Voice off'}
            </Button>
            <Button variant="ghost" size="sm" onClick={startOver} data-testid="conversation-new">
              <RotateCcw />
              New conversation
            </Button>
          </div>
        )}
      </PageHeader>

      {!started ? (
        <div
          className="space-y-4 rounded-2xl border border-border bg-card p-5"
          data-testid="conversation-intro"
        >
          <p className="text-sm text-muted-foreground">
            Talk with an AI partner in {pack.name}. It uses the words you have marked, with up to{' '}
            {newPercent}% new words in each reply.{' '}
            {voiceInput ? 'Speak with the microphone, or type.' : 'Type your replies.'}{' '}
            {engine
              ? `Replies are read aloud by ${PODCAST_ENGINE_LABELS[engine]}.`
              : voices
                ? 'No voice engine is set up, so replies are text only.'
                : ''}{' '}
            Change these in{' '}
            <Link href="/settings#conversation" className="text-primary hover:underline">
              Settings
            </Link>
            .
          </p>
          <div>
            <label htmlFor="conversation-topic" className="mb-1 block text-sm font-medium">
              Topic <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="conversation-topic"
              value={topic}
              maxLength={200}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="For example: ordering food, my weekend, travel plans"
              data-testid="conversation-topic"
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" data-testid="conversation-error">
              {error.message}
            </p>
          )}
          <Button
            className="w-full"
            onClick={() => void respond([])}
            disabled={thinking}
            data-testid="conversation-start"
          >
            {thinking ? <LoaderCircle className="animate-spin" /> : 'Start the conversation'}
          </Button>
        </div>
      ) : (
        <>
          {topic && (
            <p
              className="mb-3 text-xs text-muted-foreground"
              data-testid="conversation-topic-label"
            >
              Topic: {topic}
            </p>
          )}
          <ol className="space-y-3" data-testid="conversation-messages" aria-live="polite">
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <li key={i} className="flex justify-end" data-testid="conversation-user">
                  <TargetText
                    as="p"
                    className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-primary-foreground"
                  >
                    {m.text}
                  </TargetText>
                </li>
              ) : (
                <li key={i} className="flex justify-start" data-testid="conversation-partner">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-border bg-card px-4 py-2.5">
                    <TargetText as="p" className="text-foreground" testId="conversation-reply">
                      {m.text}
                    </TargetText>
                    {shownTranslations.has(i) && m.translation && (
                      <p
                        className="mt-1 text-sm text-muted-foreground italic"
                        data-testid="conversation-translation"
                      >
                        {m.translation}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      {engine && (
                        <button
                          type="button"
                          onClick={() => (playing === i ? stopAudio() : void play(i, m.text))}
                          className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                          aria-label={playing === i ? 'Stop' : 'Play reply'}
                          data-testid="conversation-play"
                        >
                          {playing === i ? 'Stop' : 'Play'}
                        </button>
                      )}
                      {m.translation && (
                        <button
                          type="button"
                          onClick={() => toggleTranslation(i)}
                          className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                          data-testid="conversation-toggle-translation"
                        >
                          {shownTranslations.has(i) ? 'Hide English' : 'English'}
                        </button>
                      )}
                      {m.newPercent !== undefined && (
                        <span
                          className={clsx(
                            'rounded px-1.5 py-0.5',
                            m.newPercent > newPercent && 'text-[var(--gold-strong)]',
                          )}
                          title={
                            m.newWords?.length ? `New: ${m.newWords.join(', ')}` : 'No new words'
                          }
                          data-testid="conversation-new-percent"
                        >
                          {m.newPercent}% new
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ),
            )}
            {thinking && (
              <li className="flex justify-start" data-testid="conversation-thinking">
                <span className="rounded-2xl border border-border bg-card px-4 py-2.5 text-muted-foreground">
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-label="Thinking" />
                </span>
              </li>
            )}
          </ol>
          <div ref={endRef} />

          {error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
              <span data-testid="conversation-error">{error.message}</span>
              {lastIsUser && !thinking && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void respond(messages)}
                  data-testid="conversation-retry"
                >
                  Try again
                </Button>
              )}
            </div>
          )}

          <form
            className="sticky bottom-20 mt-5 flex items-center gap-2 rounded-2xl border border-border bg-card p-2 sm:bottom-4"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            {voiceInput && (
              <MicButton
                phase={speech.phase}
                levelRef={speech.levelRef}
                onStart={() => {
                  stopAudio();
                  setHeardNothing(false);
                  void speech.start();
                }}
                onStop={speech.stop}
                disabled={thinking}
                size="md"
                label="Speak your reply"
                testId="conversation-mic"
              />
            )}
            <Input
              ref={inputRef}
              value={listening ? speech.transcript : draft}
              onChange={(e) => setDraft(e.target.value)}
              readOnly={listening}
              maxLength={CONVERSATION_MAX_MESSAGE_LENGTH}
              placeholder={listening ? 'Listening…' : `Reply in ${pack.name}`}
              aria-label={`Your reply in ${pack.name}`}
              lang={pack.script.bcp47}
              data-testid="conversation-input"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!draft.trim() || thinking || listening}
              aria-label="Send"
              data-testid="conversation-send"
            >
              <Send />
            </Button>
          </form>
          {speech.error && <p className="mt-2 text-sm text-destructive">{speech.error}</p>}
          {heardNothing && (
            <p className="mt-2 text-sm text-muted-foreground">Didn&apos;t catch that. Try again.</p>
          )}
        </>
      )}
    </main>
  );
}
