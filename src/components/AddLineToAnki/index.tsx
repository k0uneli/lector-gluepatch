'use client';

import { useState } from 'react';
import { Check, LoaderCircle, Plus, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

export interface TranscriptLine {
  text: string;
  startMs: number;
  endMs: number;
  /** This line with its neighbours, as context for the translation. */
  context: string;
}

type Status = 'idle' | 'loading' | 'done' | 'error';

const LABELS: Record<Status, string> = {
  idle: 'Add line to Anki',
  loading: 'Adding line to Anki…',
  done: 'Added to Anki',
  error: 'Could not add — retry',
};

/**
 * Hover button beside a transcript line. Hidden until the row (a `group`) is
 * hovered on a mouse; always shown on touch screens.
 */
export default function AddLineToAnki({
  line,
  onAdd,
}: {
  line: TranscriptLine;
  onAdd: (line: TranscriptLine) => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>('idle');

  const add = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (status === 'loading' || status === 'done') return;
    setStatus('loading');
    try {
      await onAdd(line);
      setStatus('done');
    } catch (error) {
      setStatus('error');
      toast.error(error instanceof Error ? error.message : 'Could not add the line to Anki');
    }
  };

  const Icon =
    status === 'loading'
      ? LoaderCircle
      : status === 'done'
        ? Check
        : status === 'error'
          ? RotateCcw
          : Plus;

  return (
    <button
      type="button"
      data-testid="add-line-to-anki"
      data-status={status}
      onClick={add}
      disabled={status === 'loading' || status === 'done'}
      title={LABELS[status]}
      aria-label={LABELS[status]}
      className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-opacity focus-visible:opacity-100 ${
        status === 'done'
          ? 'text-[var(--primary-text)]'
          : status === 'error'
            ? 'text-destructive hover:bg-accent'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      } ${status === 'idle' ? 'group-hover:opacity-100 pointer-fine:opacity-0' : ''}`}
    >
      <Icon className={`h-4 w-4 ${status === 'loading' ? 'animate-spin' : ''}`} />
    </button>
  );
}
