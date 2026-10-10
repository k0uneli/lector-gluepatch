'use client';

import { useEffect, useState } from 'react';
import { Lightbulb, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import TargetText from '@/components/TargetText';
import {
  answerRecall,
  getRecallDailyCount,
  getRecallToday,
  RecallError,
  setRecallVerdict,
  startRecallToday,
  type RecallChallenge,
  type RecallItem,
} from '@/lib/recall';
import { useActiveLanguage } from '@/utils/hooks';
import RecallFeedback from './RecallFeedback';
import RecallSummary from './RecallSummary';

type Status = 'loading' | 'ready' | 'generating';

export default function RecallPractice() {
  const pack = useActiveLanguage();
  const [status, setStatus] = useState<Status>('loading');
  const [challenge, setChallenge] = useState<RecallChallenge | null>(null);
  const [error, setError] = useState<RecallError | null>(null);
  // The answered item whose feedback is on screen; null shows the next unanswered one.
  const [feedbackIdx, setFeedbackIdx] = useState<number | null>(null);
  const [answer, setAnswer] = useState('');
  const [showHint, setShowHint] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [overriding, setOverriding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setChallenge(null);
    setError(null);
    setFeedbackIdx(null);
    getRecallToday()
      .then((today) => {
        if (!cancelled) setChallenge(today);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof RecallError ? err : new RecallError(String(err)));
      })
      .finally(() => {
        if (!cancelled) setStatus('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [pack.code]);

  const replaceItem = (item: RecallItem) =>
    setChallenge((prev) =>
      prev ? { ...prev, items: prev.items.map((i) => (i.idx === item.idx ? item : i)) } : prev,
    );

  const start = async () => {
    setStatus('generating');
    setError(null);
    try {
      setChallenge(await startRecallToday(getRecallDailyCount()));
    } catch (err) {
      setError(err instanceof RecallError ? err : new RecallError(String(err)));
    } finally {
      setStatus('ready');
    }
  };

  const submit = async (item: RecallItem, giveUp: boolean) => {
    if (!challenge || submitting) return;
    setSubmitting(true);
    try {
      const graded = await answerRecall(challenge.day, item.idx, giveUp ? '' : answer, giveUp);
      replaceItem(graded);
      setFeedbackIdx(graded.idx);
      setAnswer('');
      setShowHint(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not grade the answer');
    } finally {
      setSubmitting(false);
    }
  };

  const override = async (item: RecallItem) => {
    if (!challenge) return;
    setOverriding(true);
    try {
      replaceItem(await setRecallVerdict(challenge.day, item.idx, !item.correct));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change the verdict');
    } finally {
      setOverriding(false);
    }
  };

  if (status === 'loading') {
    return (
      <div className="flex justify-center py-12">
        <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === 'generating') {
    return (
      <div
        className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card p-8 text-center"
        data-testid="recall-generating"
      >
        <LoaderCircle className="h-6 w-6 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Writing today’s sentences from your vocab…</p>
      </div>
    );
  }

  const items = challenge?.items ?? [];
  if (items.length === 0) {
    return (
      <div
        className="space-y-4 rounded-2xl border border-border bg-card p-5"
        data-testid="recall-intro"
      >
        <h2 className="text-base font-semibold text-foreground">Today’s recall</h2>
        <p className="text-sm text-muted-foreground">
          Translate {getRecallDailyCount()} English sentences into {pack.name}. Every sentence is
          built from words in your vocab. Words you get right move up a level, and words you miss
          move down.
        </p>
        {error && (
          <p className="text-sm text-destructive" data-testid="recall-error">
            {error.message}
          </p>
        )}
        {error?.code !== 'NOT_ENOUGH_VOCAB' && (
          <Button onClick={start} className="w-full" data-testid="recall-start">
            {error ? 'Try again' : 'Start today’s challenge'}
          </Button>
        )}
      </div>
    );
  }

  const focused =
    feedbackIdx !== null
      ? items.find((i) => i.idx === feedbackIdx)
      : items.find((i) => i.correct === null);
  if (!focused) return <RecallSummary items={items} />;

  const answeredCount = items.filter((i) => i.correct !== null).length;
  const score = items.filter((i) => i.correct).length;
  const position = items.indexOf(focused) + 1;
  const isLast = items.every((i) => i.idx === focused.idx || i.correct !== null);

  return (
    <div className="space-y-4" data-testid="recall-practice">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span data-testid="recall-progress">
          Sentence {position} of {items.length}
        </span>
        <span>
          {score}/{answeredCount} correct
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${(answeredCount / items.length) * 100}%` }}
        />
      </div>

      <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
        <p className="text-xl font-medium text-foreground" data-testid="recall-english">
          {focused.english}
        </p>

        {focused.correct === null ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (answer.trim()) void submit(focused, false);
            }}
          >
            {showHint && (
              <p className="text-sm text-muted-foreground" data-testid="recall-hint">
                Use: <TargetText as="span">{focused.words.join(', ')}</TargetText>
              </p>
            )}
            <Input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={`Translate into ${pack.name}`}
              aria-label={`Your ${pack.name} translation`}
              dir={pack.script.direction}
              lang={pack.script.bcp47}
              autoFocus
              disabled={submitting}
              data-testid="recall-input"
              className="h-11 text-lg"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={submitting || !answer.trim()}
                data-testid="recall-submit"
              >
                {submitting ? (
                  <>
                    <LoaderCircle className="h-4 w-4 animate-spin" /> Checking…
                  </>
                ) : (
                  'Check'
                )}
              </Button>
              {!showHint && focused.words.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowHint(true)}
                  data-testid="recall-show-hint"
                >
                  <Lightbulb className="h-4 w-4" /> Hint
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => void submit(focused, true)}
                disabled={submitting}
                data-testid="recall-give-up"
              >
                Show answer
              </Button>
            </div>
          </form>
        ) : (
          <RecallFeedback
            item={focused}
            isLast={isLast}
            isOverriding={overriding}
            onOverride={() => void override(focused)}
            onNext={() => setFeedbackIdx(null)}
          />
        )}
      </div>
    </div>
  );
}
