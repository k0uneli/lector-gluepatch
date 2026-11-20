'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { startRecognition, type Recognition } from './index';

export type CapturePhase = 'idle' | 'starting' | 'listening' | 'finishing' | 'error';

/** One utterance per `start()`; `onFinal` gets the final transcript. Capture stops at a pause. */
export function useSpeechCapture(language: string, onFinal: (transcript: string) => void) {
  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef<CapturePhase>('idle');
  const sessionRef = useRef(0);
  const recognitionRef = useRef<Recognition | null>(null);
  const onFinalRef = useRef(onFinal);
  /** Scaled with the input level; attach to a ring element. */
  const levelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    onFinalRef.current = onFinal;
  });

  const moveTo = (next: CapturePhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const cancel = useCallback(() => {
    sessionRef.current++;
    recognitionRef.current?.cancel();
    recognitionRef.current = null;
    if (phaseRef.current !== 'error') moveTo('idle');
  }, []);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(async () => {
    if (!['idle', 'error'].includes(phaseRef.current)) return;
    const session = ++sessionRef.current;
    setTranscript('');
    setError(null);
    moveTo('starting');
    try {
      const recognition = await startRecognition(language, {
        onTranscript: (text, final) => {
          if (session !== sessionRef.current) return;
          setTranscript(text);
          if (!final) return;
          recognitionRef.current = null;
          moveTo('idle');
          onFinalRef.current(text);
        },
        onError: (message) => {
          if (session !== sessionRef.current) return;
          recognitionRef.current = null;
          setError(message);
          moveTo('error');
        },
        onCaptureEnd: () => {
          if (session === sessionRef.current && phaseRef.current === 'listening') {
            moveTo('finishing');
          }
        },
        onLevel: (level) => {
          if (levelRef.current) {
            levelRef.current.style.transform = `scale(${1 + Math.min(level * 8, 0.45)})`;
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
      setError(err instanceof Error ? err.message : 'The microphone could not start.');
      moveTo('error');
    }
  }, [language]);

  const stop = useCallback(() => {
    if (phaseRef.current === 'listening') recognitionRef.current?.stop();
  }, []);

  return { phase, transcript, error, start, stop, cancel, levelRef };
}
