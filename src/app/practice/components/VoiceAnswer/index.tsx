'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { getActivePack } from '@/lib/data-layer';
import { isComposing } from '@/lib/keyboard';
import { startRecognition, type Recognition } from '@/lib/stt';
import { splitTrailingPunctuation } from '@/lib/words';
import { VOICE_MAX_ATTEMPTS } from '../../constants';
import type { CurrentSentence } from '../../types';
import { matchVoiceAnswer, normalize } from '../../utils';

type Phase =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'finishing'
  | 'retry'
  | 'error'
  | 'matched'
  | 'done';

const STATUS: Partial<Record<Phase, string>> = {
  idle: 'Say the missing word, or the whole sentence',
  starting: 'Starting the microphone…',
  listening: 'Listening…',
  finishing: 'Checking…',
  matched: 'Correct!',
};

export default function VoiceAnswer({
  current,
  onAnswer,
  onTypeInstead,
}: {
  current: CurrentSentence;
  onAnswer: (isCorrect: boolean, transcript: string) => void;
  onTypeInstead: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const phaseRef = useRef<Phase>('idle');
  const sessionRef = useRef(0);
  const attemptsRef = useRef(0);
  const recognitionRef = useRef<Recognition | null>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const onAnswerRef = useRef(onAnswer);
  const toggleRef = useRef<() => void>(() => {});

  const pack = getActivePack();
  const answer = normalize(splitTrailingPunctuation(current.sentence.clozeWord)[0], pack);

  const moveTo = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const endSession = () => {
    sessionRef.current++;
    recognitionRef.current?.cancel();
    recognitionRef.current = null;
  };

  const settle = (isCorrect: boolean, text: string) => {
    endSession();
    moveTo(isCorrect ? 'matched' : 'done');
    onAnswerRef.current(isCorrect, text);
  };

  const handleTranscript = (session: number, text: string, final: boolean) => {
    if (session !== sessionRef.current) return;
    setTranscript(text);
    if (matchVoiceAnswer(text, current.sentence, pack)) {
      settle(true, text);
      return;
    }
    if (!final) return;
    recognitionRef.current = null;
    if (!text.trim()) {
      setMessage("Didn't catch that. Try again.");
      moveTo('retry');
      return;
    }
    attemptsRef.current++;
    if (attemptsRef.current >= VOICE_MAX_ATTEMPTS) {
      settle(false, text);
      return;
    }
    const left = VOICE_MAX_ATTEMPTS - attemptsRef.current;
    setMessage(`Not quite. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    moveTo('retry');
  };

  const start = async () => {
    if (!['idle', 'retry', 'error'].includes(phaseRef.current)) return;
    const session = ++sessionRef.current;
    setTranscript('');
    setMessage(null);
    moveTo('starting');
    try {
      const recognition = await startRecognition(pack.code, {
        onTranscript: (text, final) => handleTranscript(session, text, final),
        onError: (error) => {
          if (session !== sessionRef.current) return;
          recognitionRef.current = null;
          setMessage(error);
          moveTo('error');
        },
        onCaptureEnd: () => {
          if (session === sessionRef.current && phaseRef.current === 'listening') {
            moveTo('finishing');
          }
        },
        onLevel: (level) => {
          if (ringRef.current) {
            ringRef.current.style.transform = `scale(${1 + Math.min(level * 8, 0.45)})`;
          }
        },
      });
      if (session !== sessionRef.current) {
        recognition.cancel();
        return;
      }
      recognitionRef.current = recognition;
      if (phaseRef.current === 'starting') moveTo('listening');
    } catch (err) {
      if (session !== sessionRef.current) return;
      setMessage(err instanceof Error ? err.message : 'The microphone could not start.');
      moveTo('error');
    }
  };

  const stop = () => {
    if (phaseRef.current === 'listening') recognitionRef.current?.stop();
  };

  const typeInstead = () => {
    endSession();
    onTypeInstead();
  };

  useEffect(() => {
    onAnswerRef.current = onAnswer;
    toggleRef.current = () => {
      if (phaseRef.current === 'listening') stop();
      else void start();
    };
  });

  useEffect(
    () => () => {
      sessionRef.current++;
      recognitionRef.current?.cancel();
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isComposing(e) || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement && target.closest('button, input, textarea, select, a')) {
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const listening = phase === 'listening';
  const busy = phase === 'starting' || phase === 'finishing';
  const answered = phase === 'matched' || phase === 'done';
  const words = transcript.split(/\s+/).filter(Boolean);

  return (
    <div className="flex flex-col items-center gap-4 py-2" data-testid="voice-answer">
      <button
        type="button"
        onClick={listening ? stop : () => void start()}
        disabled={busy || answered}
        aria-label={listening ? 'Stop listening' : 'Speak your answer'}
        aria-pressed={listening}
        data-testid="voice-mic"
        className={`relative flex h-24 w-24 items-center justify-center rounded-full border-2 transition-colors active:scale-95 disabled:cursor-not-allowed ${
          listening
            ? 'border-primary text-primary'
            : 'border-[var(--clay)] bg-[color-mix(in_srgb,var(--clay)_12%,var(--card))] text-foreground hover:border-primary hover:text-primary'
        }`}
      >
        <span
          ref={ringRef}
          aria-hidden
          className={`absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--primary)_18%,var(--card))] transition-transform duration-75 ${
            listening ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <span className="relative">
          {busy ? (
            <Loader2 className="h-10 w-10 animate-spin" />
          ) : listening ? (
            <Square className="h-8 w-8" fill="currentColor" />
          ) : (
            <Mic className="h-10 w-10" />
          )}
        </span>
      </button>

      <p className="text-sm text-muted-foreground" data-testid="voice-status">
        {STATUS[phase] ?? ''}
      </p>

      <p
        dir={pack.script.direction}
        lang={pack.script.bcp47}
        data-testid="voice-transcript"
        className="min-h-9 text-center text-xl font-medium text-foreground"
        style={{ unicodeBidi: 'isolate' }}
      >
        {words.map((word, i) => {
          const hit = phase === 'matched' && normalize(word, pack) === answer;
          return (
            <span key={i}>
              {i > 0 && ' '}
              <span
                data-testid="voice-word"
                className={`inline-block animate-in duration-200 fade-in slide-in-from-bottom-1 ${
                  hit
                    ? 'rounded bg-[color-mix(in_srgb,var(--primary)_14%,var(--card))] px-1 text-primary'
                    : ''
                }`}
              >
                {word}
              </span>
            </span>
          );
        })}
      </p>

      {message && (
        <p
          role={phase === 'error' ? 'alert' : 'status'}
          data-testid="voice-message"
          className={`text-sm ${phase === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {message}
          {phase === 'error' && (
            <>
              {' '}
              <Link href="/settings" className="underline underline-offset-2">
                Voice Recognition settings
              </Link>
            </>
          )}
        </p>
      )}

      <div className="flex justify-center gap-2">
        <Button type="button" variant="secondary" onClick={typeInstead} disabled={answered}>
          Type instead
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => settle(false, transcript)}
          disabled={answered}
          title="Reveal the answer (counts as a miss)"
        >
          Give up
        </Button>
      </div>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Kbd>Space</Kbd>
        {listening ? 'Stop' : 'Speak'}
      </div>
    </div>
  );
}
