'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeWav } from './audio';
import { startRecognition, type Recognition, type RecognitionOptions } from './index';

export type CapturePhase = 'idle' | 'starting' | 'listening' | 'finishing' | 'error';

export type SpeechCaptureOptions = Omit<RecognitionOptions, 'onAudio'> & {
  /** Hand `onFinal` the utterance as a WAV file. */
  keepRecording?: boolean;
};

/** One utterance per `start()`; `onFinal` gets the final transcript. */
export function useSpeechCapture(
  language: string,
  onFinal: (transcript: string, recording: Blob | null) => void,
  options: SpeechCaptureOptions = {},
) {
  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef<CapturePhase>('idle');
  const sessionRef = useRef(0);
  const recognitionRef = useRef<Recognition | null>(null);
  const onFinalRef = useRef(onFinal);
  const optionsRef = useRef(options);
  /** Scaled with the input level; attach to a ring element. */
  const levelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    onFinalRef.current = onFinal;
    optionsRef.current = options;
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
    const { keepRecording, ...recognitionOptions } = optionsRef.current;
    const chunks: Int16Array[] = [];
    setTranscript('');
    setError(null);
    moveTo('starting');
    try {
      const recognition = await startRecognition(
        language,
        {
          onTranscript: (text, final) => {
            if (session !== sessionRef.current) return;
            setTranscript(text);
            if (!final) return;
            recognitionRef.current = null;
            moveTo('idle');
            onFinalRef.current(text, keepRecording && chunks.length > 0 ? encodeWav(chunks) : null);
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
        },
        { ...recognitionOptions, onAudio: keepRecording ? (pcm) => chunks.push(pcm) : undefined },
      );
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
