'use client';

import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import TargetText from '@/components/TargetText';
import type { TurnCorrection } from '@/lib/conversation';
import { diffCorrection } from '@/lib/correction-diff';
import { useActiveLanguage } from '@/utils/hooks';

/** The learner's turn again, with the parts to change marked in red. */
export default function CorrectionBubble({
  original,
  correction,
}: {
  original: string;
  correction: TurnCorrection;
}) {
  const pack = useActiveLanguage();
  const [open, setOpen] = useState(false);
  const segments = useMemo(
    () => diffCorrection(original, correction.corrected, pack),
    [original, correction.corrected, pack],
  );
  const changed = segments.some((s) => s.kind !== 'same');

  if (!changed && correction.corrections.length === 0) {
    return (
      <p
        className="mt-1 flex items-center justify-end gap-1 text-xs text-muted-foreground"
        data-testid="conversation-correct"
      >
        <Check className="h-3.5 w-3.5 text-primary" />
        Looks right
      </p>
    );
  }

  const gap = pack.script.kind === 'cjk-unspaced' ? '' : ' ';
  return (
    <div className="mt-1 flex justify-end" data-testid="conversation-correction">
      <div className="max-w-[85%] rounded-2xl rounded-tr-sm border border-destructive/30 bg-card px-4 py-2.5">
        <p
          dir={pack.script.direction}
          lang={pack.script.bcp47}
          style={{ unicodeBidi: 'isolate' }}
          className="text-foreground"
          data-testid="conversation-correction-text"
        >
          {segments.map((segment, i) => (
            <span key={i}>
              {i > 0 && gap}
              {segment.kind === 'same' ? (
                segment.text
              ) : segment.kind === 'removed' ? (
                <del
                  className="text-destructive decoration-destructive decoration-2"
                  data-testid="conversation-correction-removed"
                >
                  {segment.text}
                </del>
              ) : (
                <ins
                  className="font-semibold text-destructive no-underline"
                  data-testid="conversation-correction-added"
                >
                  {segment.text}
                </ins>
              )}
            </span>
          ))}
        </p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-expanded={open}
          data-testid="conversation-correction-toggle"
        >
          {open ? 'Hide explanation' : 'Why?'}
        </button>
        {open && (
          <div
            className="mt-2 space-y-2 border-t border-border pt-2 text-sm"
            data-testid="conversation-correction-details"
          >
            {correction.corrections.length > 0 && (
              <ul className="space-y-1.5">
                {correction.corrections.map((c, i) => (
                  <li key={i}>
                    <span className="font-medium">
                      <TargetText>
                        <del className="text-destructive">{c.original}</del> →{' '}
                        <span className="text-primary">{c.corrected}</span>
                      </TargetText>
                    </span>
                    {c.explanation && (
                      <span className="block text-muted-foreground">{c.explanation}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {correction.explanation && (
              <p className="whitespace-pre-line text-muted-foreground">{correction.explanation}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
