'use client';

import { ArrowDown, ArrowUp, Check, Volume2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TargetText from '@/components/TargetText';
import type { RecallItem } from '@/lib/recall';
import { canSpeak, speak } from '@/lib/tts';
import type { WordState } from '@/types';

const LEVEL_RANK: Record<WordState, number> = {
  new: 0,
  level1: 1,
  level2: 2,
  level3: 3,
  level4: 4,
  known: 5,
  ignored: 5,
};

const LEVEL_LABEL: Record<WordState, string> = {
  new: 'new',
  level1: 'level 1',
  level2: 'level 2',
  level3: 'level 3',
  level4: 'level 4',
  known: 'known',
  ignored: 'ignored',
};

export default function RecallFeedback({
  item,
  isLast,
  isOverriding,
  onOverride,
  onNext,
}: {
  item: RecallItem;
  isLast: boolean;
  isOverriding: boolean;
  onOverride: () => void;
  onNext: () => void;
}) {
  const gaveUp = item.answer === '';
  const overridden = item.aiCorrect !== null && item.correct !== item.aiCorrect;
  const corrected = item.feedback?.corrected;

  return (
    <div className="space-y-4" data-testid="recall-feedback">
      <div className="flex items-center gap-2">
        {item.correct ? (
          <Check className="h-5 w-5 text-primary" />
        ) : (
          <X className="h-5 w-5 text-destructive" />
        )}
        <h2
          className={`text-lg font-semibold ${item.correct ? 'text-primary' : 'text-destructive'}`}
          data-testid="recall-verdict"
        >
          {gaveUp ? 'Answer shown' : item.correct ? 'Correct' : 'Not quite'}
        </h2>
        {overridden && <span className="text-xs text-muted-foreground">(you overrode the AI)</span>}
      </div>

      {!gaveUp && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase">Your answer</p>
          <TargetText className="text-lg text-foreground" as="p">
            {item.answer}
          </TargetText>
          {corrected && corrected !== item.answer && (
            <TargetText className="mt-1 text-lg text-primary" as="p" testId="recall-corrected">
              {corrected}
            </TargetText>
          )}
        </div>
      )}

      {item.feedback && item.feedback.notes.length > 0 && (
        <ul className="space-y-1.5 text-sm" data-testid="recall-notes">
          {item.feedback.notes.map((note, i) => (
            <li key={i}>
              <TargetText as="span" className="text-destructive line-through">
                {note.original}
              </TargetText>{' '}
              →{' '}
              <TargetText as="span" className="font-medium text-primary">
                {note.corrected}
              </TargetText>
              <span className="text-muted-foreground"> — {note.explanation}</span>
            </li>
          ))}
        </ul>
      )}

      {item.reference && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase">
            {gaveUp ? 'Answer' : 'Another way to say it'}
          </p>
          <div className="flex items-center gap-2">
            <TargetText className="text-lg text-foreground" as="p" testId="recall-reference">
              {item.reference}
            </TargetText>
            {canSpeak() && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => speak(item.reference!)}
                aria-label="Listen"
              >
                <Volume2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      )}

      {item.vocabChanges.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="recall-vocab-changes">
          {item.vocabChanges.map((change) => {
            const up = LEVEL_RANK[change.to] > LEVEL_RANK[change.from];
            return (
              <span
                key={change.text}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
              >
                {up ? (
                  <ArrowUp className="h-3 w-3 text-primary" />
                ) : (
                  <ArrowDown className="h-3 w-3 text-destructive" />
                )}
                <TargetText as="span">{change.text}</TargetText>
                <span className="text-muted-foreground">{LEVEL_LABEL[change.to]}</span>
              </span>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onNext} data-testid="recall-next" autoFocus>
          {isLast ? 'See results' : 'Next sentence'}
        </Button>
        {!gaveUp && (
          <Button
            type="button"
            variant="secondary"
            onClick={onOverride}
            disabled={isOverriding}
            data-testid="recall-override"
          >
            {item.correct ? 'Mark as wrong' : 'I was right'}
          </Button>
        )}
      </div>
    </div>
  );
}
