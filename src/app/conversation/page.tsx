'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { ArrowLeft, LoaderCircle, Plus, Send, SpellCheck, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import MicButton from '@/components/MicButton';
import PageHeader from '@/components/PageHeader';
import TranslationDrawer, { TranslationDrawerSlot } from '@/components/TranslationDrawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { lectorMode } from '@/lib/api-base';
import {
  buildChatRecording,
  CONVERSATION_AUTOPLAY_KEY,
  CONVERSATION_MAX_MESSAGE_LENGTH,
  CONVERSATION_MAX_SPEECH_SECONDS,
  ConversationError,
  createChat,
  deleteChat,
  deleteChatRecording,
  fetchConversationVoices,
  getChat,
  getConversationAutoplay,
  getConversationCorrections,
  getConversationNewPercent,
  getConversationPauseSeconds,
  getConversationStopMode,
  importBrowserConversation,
  listChats,
  messageAudioUrl,
  pickEngine,
  retryReply,
  checkTurn,
  CONVERSATION_CORRECTIONS_KEY,
  sendTurn,
  speakReply,
  type Chat,
  type ChatSummary,
  type ConversationMessage,
  type ConversationStopMode,
  type ConversationVoices,
} from '@/lib/conversation';
import { PODCAST_ENGINE_LABELS, type PodcastEngineId } from '@/lib/podcast';
import { isVoiceInputSupported } from '@/lib/stt';
import { useSpeechCapture } from '@/lib/stt/use-speech-capture';
import { speak } from '@/lib/tts';
import { useWordPanel } from '@/lib/use-word-panel';
import { useAnkiTransport } from '@/lib/anki-transport';
import { addPracticeWordToAnki } from '@/app/practice/add-word-to-anki';
import { useActiveLanguage } from '@/utils/hooks';
import ChatList from './components/ChatList';
import ClickableText from './components/ClickableText';
import RecordingPanel from './components/RecordingPanel';
import CorrectionBubble from './components/CorrectionBubble';

export default function ConversationPage() {
  return (
    <Suspense>
      <ConversationView />
    </Suspense>
  );
}

function ConversationView() {
  const pack = useActiveLanguage();
  const router = useRouter();
  const chatId = useSearchParams().get('c');
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [opening, setOpening] = useState(false);
  const [topic, setTopic] = useState('');
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<ConversationError | null>(null);
  const [newPercent, setNewPercent] = useState(3);
  const [stopMode, setStopMode] = useState<ConversationStopMode>('auto');
  const [pauseSeconds, setPauseSeconds] = useState(2.5);
  const [voices, setVoices] = useState<ConversationVoices | null>(null);
  const [engine, setEngine] = useState<PodcastEngineId | null>(null);
  const [autoplay, setAutoplay] = useState(true);
  const [voiceInput, setVoiceInput] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [shownTranslations, setShownTranslations] = useState<Set<number>>(new Set());
  const [heardNothing, setHeardNothing] = useState(false);
  const [corrections, setCorrections] = useState(false);
  const [checking, setChecking] = useState<Set<number>>(new Set());
  const ankiTransport = useAnkiTransport();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrls = useRef(new Map<string, string>());
  /** Bumped whenever playback should stop, so a reply still loading never starts late. */
  const playToken = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const words = useWordPanel();

  const refreshChats = useCallback(async () => {
    try {
      setChats(await listChats());
    } catch {
      setChats([]);
    }
  }, []);

  useEffect(() => {
    const load = () => {
      setNewPercent(getConversationNewPercent());
      setAutoplay(getConversationAutoplay());
      setStopMode(getConversationStopMode());
      setCorrections(getConversationCorrections());
      setPauseSeconds(getConversationPauseSeconds());
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
    importBrowserConversation(pack.code)
      .catch(() => null)
      .finally(() => {
        if (!cancelled) void refreshChats();
      });
    return () => {
      cancelled = true;
    };
  }, [pack.code, refreshChats]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setError(null);
      setShownTranslations(new Set());
      if (!chatId) {
        setChat(null);
        return;
      }
      setOpening(true);
      try {
        const loaded = await getChat(chatId);
        if (!cancelled) setChat(loaded);
      } catch (err) {
        if (!cancelled) {
          setChat(null);
          toast.error(err instanceof Error ? err.message : 'Could not open the conversation');
          router.replace('/conversation');
        }
      } finally {
        if (!cancelled) setOpening(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [chatId, router]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [chat?.messages.length, thinking]);

  useEffect(() => {
    const urls = audioUrls.current;
    return () => {
      audioRef.current?.pause();
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const stopAudio = useCallback(() => {
    playToken.current++;
    audioRef.current?.pause();
    setPlaying(null);
  }, []);

  /** Plays one source; `load` may take seconds, and a newer stop or play wins. */
  const playSource = useCallback(async (key: string, load: () => Promise<string>) => {
    const token = ++playToken.current;
    audioRef.current?.pause();
    setPlaying(key);
    try {
      const url = await load();
      if (token !== playToken.current) return;
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.src = url;
      audio.onended = () => setPlaying((p) => (p === key ? null : p));
      await audio.play();
    } catch (err) {
      if (token !== playToken.current) return;
      setPlaying(null);
      setError(
        err instanceof ConversationError
          ? err
          : new ConversationError('The audio could not be played.'),
      );
    }
  }, []);

  const playReply = useCallback(
    (index: number, text: string) => {
      if (!engine) return;
      void playSource(`reply-${index}`, async () => {
        const key = `${engine}:${text}`;
        let url = audioUrls.current.get(key);
        if (!url) {
          url = URL.createObjectURL(await speakReply(text, engine));
          audioUrls.current.set(key, url);
        }
        return url;
      });
    },
    [engine, playSource],
  );

  const playMine = (id: string, idx: number) =>
    void playSource(`mine-${idx}`, async () => messageAudioUrl(id, idx));

  const updateSummary = (patch: Partial<ChatSummary>) =>
    setChat((prev) => prev && { ...prev, chat: { ...prev.chat, ...patch } });

  const start = async () => {
    setThinking(true);
    setError(null);
    try {
      const created = await createChat(topic.trim(), newPercent);
      setChat(created);
      setTopic('');
      router.push(`/conversation?c=${created.chat.id}`);
      const opener = created.messages.at(-1);
      if (autoplay && engine && opener) playReply(opener.idx, opener.text);
    } catch (err) {
      setError(err instanceof ConversationError ? err : new ConversationError(String(err)));
    } finally {
      setThinking(false);
    }
  };

  const afterReply = (messages: ConversationMessage[]) => {
    const reply = messages.find((m) => m.role === 'assistant');
    if (reply && autoplay && engine && speech.phase === 'idle') playReply(reply.idx, reply.text);
  };

  const recover = async (id: string, err: unknown) => {
    setError(err instanceof ConversationError ? err : new ConversationError(String(err)));
    try {
      setChat(await getChat(id));
    } catch {
      // Keep what is on screen; the retry reloads it.
    }
  };

  const send = async (text: string, recording: Blob | null) => {
    const trimmed = text.trim().slice(0, CONVERSATION_MAX_MESSAGE_LENGTH);
    if (!trimmed || thinking || !chat) return;
    const id = chat.chat.id;
    const pending: ConversationMessage = {
      idx: -1,
      role: 'user',
      text: trimmed,
      translation: null,
      newPercent: null,
      newWords: [],
      hasAudio: false,
      correction: null,
      createdAt: new Date().toISOString(),
    };
    setChat((prev) => prev && { ...prev, messages: [...prev.messages, pending] });
    setDraft('');
    setThinking(true);
    setError(null);
    try {
      const added = await sendTurn(id, trimmed, newPercent, recording, corrections);
      setChat(
        (prev) =>
          prev && {
            ...prev,
            messages: [...prev.messages.filter((m) => m.idx !== -1), ...added],
          },
      );
      afterReply(added);
    } catch (err) {
      await recover(id, err);
    } finally {
      setThinking(false);
    }
  };

  const retry = async () => {
    if (!chat) return;
    const id = chat.chat.id;
    setThinking(true);
    setError(null);
    try {
      const added = await retryReply(id, newPercent);
      setChat((prev) => prev && { ...prev, messages: [...prev.messages, ...added] });
      afterReply(added);
    } catch (err) {
      await recover(id, err);
    } finally {
      setThinking(false);
    }
  };

  const speech = useSpeechCapture(
    pack.code,
    (transcript, recording) => {
      setHeardNothing(!transcript.trim());
      void send(transcript, recording);
    },
    {
      endpointing:
        stopMode === 'manual'
          ? 'manual'
          : { silenceMs: pauseSeconds * 1000, noSpeechMs: Math.max(12_000, pauseSeconds * 2000) },
      maxSeconds: CONVERSATION_MAX_SPEECH_SECONDS,
      keepRecording: true,
    },
  );

  const goToList = () => {
    speech.cancel();
    stopAudio();
    words.close();
    router.push('/conversation');
    void refreshChats();
  };

  const removeChat = async (id: string) => {
    try {
      await deleteChat(id);
      setChats((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the conversation');
    }
  };

  const buildRecording = async () => {
    if (!chat || !engine) return;
    setBuilding(true);
    try {
      updateSummary({ recording: await buildChatRecording(chat.chat.id, engine) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the recording');
    } finally {
      setBuilding(false);
    }
  };

  const removeRecording = async () => {
    if (!chat) return;
    try {
      await deleteChatRecording(chat.chat.id);
      updateSummary({ recording: null });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the recording');
    }
  };

  const toggleCorrections = () => {
    const next = !corrections;
    setCorrections(next);
    localStorage.setItem(CONVERSATION_CORRECTIONS_KEY, String(next));
  };

  const check = async (idx: number) => {
    if (!chat) return;
    const id = chat.chat.id;
    setChecking((prev) => new Set(prev).add(idx));
    try {
      const updated = await checkTurn(id, idx);
      setChat(
        (prev) =>
          prev && {
            ...prev,
            messages: prev.messages.map((m) => (m.idx === updated.idx ? updated : m)),
          },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not check this turn');
    } finally {
      setChecking((prev) => {
        const next = new Set(prev);
        next.delete(idx);
        return next;
      });
    }
  };

  const addWordToAnki = async () => {
    if (!panel || ankiTransport === 'unknown') return;
    const { audioFailed } = await addPracticeWordToAnki(
      {
        word: panel.word,
        translation: panel.translation,
        aiContextTranslation: panel.aiContextTranslation,
        aiStructured: null,
        dictEntry: panel.dictEntry,
      },
      panel.sentence,
      ankiTransport,
      pack,
    );
    if (audioFailed) toast.warning('Added to Anki without audio: no server voice.');
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

  const messages = chat?.messages ?? [];
  const lastIsUser = messages.at(-1)?.role === 'user';
  const listening = speech.phase === 'listening' || speech.phase === 'finishing';
  const panel = words.panel;

  return (
    <main className="mx-auto flex max-w-3xl flex-col px-4 py-8 pb-28 sm:px-6 sm:pb-8 lg:px-8">
      <PageHeader title="Conversation">
        {chat && (
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
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleCorrections}
              aria-pressed={corrections}
              data-testid="conversation-corrections"
              title="Check each of your turns for mistakes"
            >
              <SpellCheck />
              {corrections ? 'Corrections on' : 'Corrections off'}
            </Button>
            <Button variant="ghost" size="sm" onClick={goToList} data-testid="conversation-new">
              <Plus />
              New conversation
            </Button>
          </div>
        )}
      </PageHeader>

      {opening ? (
        <div className="flex justify-center py-12">
          <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !chat ? (
        <>
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
              onClick={() => void start()}
              disabled={thinking}
              data-testid="conversation-start"
            >
              {thinking ? <LoaderCircle className="animate-spin" /> : 'Start the conversation'}
            </Button>
          </div>
          <ChatList
            chats={chats}
            onOpen={(id) => router.push(`/conversation?c=${id}`)}
            onDelete={(id) => void removeChat(id)}
          />
        </>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={goToList}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid="conversation-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All conversations
            </button>
            {chat.chat.topic && (
              <p className="text-xs text-muted-foreground" data-testid="conversation-topic-label">
                · Topic: {chat.chat.topic}
              </p>
            )}
          </div>

          <RecordingPanel
            chat={chat.chat}
            messageCount={messages.filter((m) => m.idx >= 0).length}
            canBuild={!!engine}
            building={building}
            onBuild={() => void buildRecording()}
            onDelete={() => void removeRecording()}
          />

          <ol className="space-y-3" data-testid="conversation-messages" aria-live="polite">
            {messages.map((m) =>
              m.role === 'user' ? (
                <li key={m.idx} data-testid="conversation-user">
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-primary-foreground">
                      <ClickableText
                        text={m.text}
                        onWord={words.open}
                        wordClassName="hover:bg-white/20"
                        testId="conversation-user-text"
                      />
                      {m.hasAudio && (
                        <button
                          type="button"
                          onClick={() =>
                            playing === `mine-${m.idx}`
                              ? stopAudio()
                              : playMine(chat.chat.id, m.idx)
                          }
                          className="mt-1 rounded px-1.5 py-0.5 text-xs opacity-80 hover:bg-white/20 hover:opacity-100"
                          data-testid="conversation-play-mine"
                        >
                          {playing === `mine-${m.idx}` ? 'Stop' : 'Play my recording'}
                        </button>
                      )}
                      {corrections && !m.correction && m.idx >= 0 && (
                        <button
                          type="button"
                          onClick={() => void check(m.idx)}
                          disabled={checking.has(m.idx)}
                          className="mt-1 rounded px-1.5 py-0.5 text-xs opacity-80 hover:bg-white/20 hover:opacity-100"
                          data-testid="conversation-check"
                        >
                          {checking.has(m.idx) ? 'Checking…' : 'Check grammar'}
                        </button>
                      )}
                    </div>
                  </div>
                  {m.correction && <CorrectionBubble original={m.text} correction={m.correction} />}
                </li>
              ) : (
                <li key={m.idx} className="flex justify-start" data-testid="conversation-partner">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-border bg-card px-4 py-2.5">
                    <ClickableText
                      text={m.text}
                      onWord={words.open}
                      className="text-foreground"
                      wordClassName="hover:bg-accent"
                      testId="conversation-reply"
                    />
                    {shownTranslations.has(m.idx) && m.translation && (
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
                          onClick={() =>
                            playing === `reply-${m.idx}` ? stopAudio() : playReply(m.idx, m.text)
                          }
                          className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                          aria-label={playing === `reply-${m.idx}` ? 'Stop' : 'Play reply'}
                          data-testid="conversation-play"
                        >
                          {playing === `reply-${m.idx}` ? 'Stop' : 'Play'}
                        </button>
                      )}
                      {m.translation && (
                        <button
                          type="button"
                          onClick={() => toggleTranslation(m.idx)}
                          className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                          data-testid="conversation-toggle-translation"
                        >
                          {shownTranslations.has(m.idx) ? 'Hide English' : 'English'}
                        </button>
                      )}
                      {m.newPercent !== null && (
                        <span
                          className={clsx(
                            'rounded px-1.5 py-0.5',
                            m.newPercent > newPercent && 'text-[var(--gold-strong)]',
                          )}
                          title={
                            m.newWords.length ? `New: ${m.newWords.join(', ')}` : 'No new words'
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
                  onClick={() => void retry()}
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
              void send(draft, null);
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
                disabled={thinking || lastIsUser}
                size="md"
                label="Speak your reply"
                testId="conversation-mic"
              />
            )}
            <Input
              value={listening ? speech.transcript : draft}
              onChange={(e) => setDraft(e.target.value)}
              readOnly={listening}
              maxLength={CONVERSATION_MAX_MESSAGE_LENGTH}
              placeholder={
                listening
                  ? stopMode === 'manual'
                    ? 'Listening… press stop when you finish'
                    : 'Listening…'
                  : `Reply in ${pack.name}`
              }
              aria-label={`Your reply in ${pack.name}`}
              lang={pack.script.bcp47}
              data-testid="conversation-input"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!draft.trim() || thinking || listening || lastIsUser}
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

      <TranslationDrawerSlot>
        <TranslationDrawer
          isOpen={!!panel}
          word={panel?.word ?? ''}
          sentence={panel?.sentence ?? ''}
          entry={panel?.dictEntry ?? null}
          aiTranslation={panel?.translation ?? null}
          aiPartOfSpeech={panel?.partOfSpeech ?? null}
          aiContextTranslation={panel?.aiContextTranslation ?? null}
          isDictionaryResult={!!panel?.dictEntry}
          isLoading={panel?.isLoading ?? false}
          isContextLoading={panel?.isContextLoading ?? false}
          error={panel?.error ?? null}
          existingEntry={panel?.existingEntry ?? null}
          wordState={panel?.wordState}
          onClose={words.close}
          onSpeak={(text) => speak(text)}
          onSetLevel={(level) => void words.setLevel(level)}
          onMarkKnown={() => void words.markKnown()}
          onIgnore={() => void words.ignore()}
          onRequestContextTranslation={() => void words.requestContextTranslation()}
          onLookupWord={(word) => void words.open(word, panel?.sentence ?? '')}
          onAddToAnki={ankiTransport === 'unknown' ? undefined : addWordToAnki}
          ankiInHeader
        />
      </TranslationDrawerSlot>
    </main>
  );
}
