'use client';

import type { RefObject } from 'react';
import clsx from 'clsx';
import { Loader2, Mic, Square } from 'lucide-react';
import type { CapturePhase } from '@/lib/stt/use-speech-capture';

export default function MicButton({
  phase,
  levelRef,
  onStart,
  onStop,
  disabled = false,
  size = 'lg',
  label = 'Speak',
  testId = 'mic-button',
}: {
  phase: CapturePhase;
  levelRef: RefObject<HTMLElement | null>;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
  size?: 'md' | 'lg';
  label?: string;
  testId?: string;
}) {
  const listening = phase === 'listening';
  const busy = phase === 'starting' || phase === 'finishing';
  const icon = size === 'lg' ? 'h-9 w-9' : 'h-6 w-6';
  return (
    <button
      type="button"
      onClick={listening ? onStop : onStart}
      disabled={disabled || busy}
      aria-label={listening ? 'Stop listening' : label}
      aria-pressed={listening}
      data-testid={testId}
      data-phase={phase}
      className={clsx(
        'relative flex shrink-0 items-center justify-center rounded-full border-2 transition-colors active:scale-95 disabled:cursor-not-allowed disabled:opacity-60',
        size === 'lg' ? 'h-20 w-20' : 'h-12 w-12',
        listening
          ? 'border-primary text-primary'
          : 'border-[var(--clay)] bg-[color-mix(in_srgb,var(--clay)_12%,var(--card))] text-foreground hover:border-primary hover:text-primary',
      )}
    >
      <span
        ref={levelRef as RefObject<HTMLSpanElement | null>}
        aria-hidden
        className={clsx(
          'absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--primary)_18%,var(--card))] transition-transform duration-75',
          listening ? 'opacity-100' : 'opacity-0',
        )}
      />
      <span className="relative">
        {busy ? (
          <Loader2 className={clsx(icon, 'animate-spin')} />
        ) : listening ? (
          <Square className={size === 'lg' ? 'h-7 w-7' : 'h-5 w-5'} fill="currentColor" />
        ) : (
          <Mic className={icon} />
        )}
      </span>
    </button>
  );
}
