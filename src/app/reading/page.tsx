'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BookOpen, LoaderCircle } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import TargetText from '@/components/TargetText';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  getReadingChallenge,
  getReadingNewPercent,
  getReadingWords,
  ReadingChallengeError,
  startReadingChallenge,
  type ReadingChallenge,
} from '@/lib/reading-challenge';
import { useActiveLanguage } from '@/utils/hooks';

type Status = 'loading' | 'ready' | 'generating';

export default function ReadingChallengePage() {
  const pack = useActiveLanguage();
  const [status, setStatus] = useState<Status>('loading');
  const [challenge, setChallenge] = useState<ReadingChallenge | null>(null);
  const [error, setError] = useState<ReadingChallengeError | null>(null);
  const [showNewWords, setShowNewWords] = useState(false);
  const [settings, setSettings] = useState({ words: 0, newPercent: 0 });

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setChallenge(null);
    setError(null);
    setShowNewWords(false);
    setSettings({ words: getReadingWords(), newPercent: getReadingNewPercent() });
    getReadingChallenge()
      .then((today) => {
        if (!cancelled) setChallenge(today.challenge);
      })
      .catch((err) => {
        if (!cancelled) setError(toError(err));
      })
      .finally(() => {
        if (!cancelled) setStatus('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [pack.code]);

  const start = async () => {
    setStatus('generating');
    setError(null);
    try {
      setChallenge((await startReadingChallenge(settings.words, settings.newPercent)).challenge);
    } catch (err) {
      setError(toError(err));
    } finally {
      setStatus('ready');
    }
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 pb-24 sm:px-6 sm:pb-8 lg:px-8">
      <PageHeader title="Daily Reading" />
      {status === 'loading' ? (
        <div className="flex justify-center py-12">
          <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : status === 'generating' ? (
        <div
          className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card p-8 text-center"
          data-testid="reading-generating"
        >
          <LoaderCircle className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            Writing today’s text from your vocabulary…
          </p>
        </div>
      ) : challenge ? (
        <div
          className="space-y-4 rounded-2xl border border-border bg-card p-5"
          data-testid="reading-challenge"
        >
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Today’s text
            </p>
            <h2 className="text-xl font-semibold text-foreground">
              <TargetText testId="reading-title">{challenge.title}</TargetText>
            </h2>
          </div>

          <dl className="grid grid-cols-3 gap-3 text-center">
            <Stat label="Words" value={String(challenge.wordCount)} testId="reading-word-count" />
            <Stat
              label="New words"
              value={`${challenge.newPercent}%`}
              sublabel={`target ${challenge.targetNewPercent}%`}
              testId="reading-new-percent"
            />
            <Stat
              label="Read"
              value={`${Math.round(challenge.progress)}%`}
              testId="reading-progress"
            />
          </dl>

          <Link
            href={`/read/${challenge.lessonId}`}
            className={buttonVariants({ className: 'w-full' })}
            data-testid="reading-open"
          >
            <BookOpen size={16} />
            {challenge.progress > 0 ? 'Continue reading' : 'Start reading'}
          </Link>

          {challenge.newWords.length > 0 && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowNewWords((v) => !v)}
                data-testid="reading-toggle-new-words"
              >
                {showNewWords
                  ? 'Hide new words'
                  : `Show ${challenge.newWords.length} new ${challenge.newWords.length === 1 ? 'word' : 'words'}`}
              </Button>
              {showNewWords && (
                <TargetText
                  as="p"
                  className="mt-2 text-sm text-muted-foreground"
                  testId="reading-new-words"
                >
                  {challenge.newWords.join(', ')}
                </TargetText>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Today’s text is also in your library, in the Daily Reading collection. A new one is
            ready tomorrow.
          </p>
        </div>
      ) : (
        <div
          className="space-y-4 rounded-2xl border border-border bg-card p-5"
          data-testid="reading-intro"
        >
          <h2 className="text-base font-semibold text-foreground">Today’s reading challenge</h2>
          <p className="text-sm text-muted-foreground">
            Read a {pack.name} text of about {settings.words} words, written from the words you have
            marked. About {settings.newPercent}% of it is new vocabulary. Change the length and the
            share of new words in{' '}
            <Link href="/settings" className="text-primary hover:underline">
              Settings
            </Link>
            .
          </p>
          {error && (
            <p className="text-sm text-destructive" data-testid="reading-error">
              {error.message}
            </p>
          )}
          {error?.code !== 'NOT_ENOUGH_VOCAB' && (
            <Button onClick={start} className="w-full" data-testid="reading-start">
              {error ? 'Try again' : 'Write today’s text'}
            </Button>
          )}
        </div>
      )}
    </main>
  );
}

function toError(err: unknown): ReadingChallengeError {
  return err instanceof ReadingChallengeError ? err : new ReadingChallengeError(String(err));
}

function Stat(props: { label: string; value: string; sublabel?: string; testId: string }) {
  return (
    <div className="rounded-xl bg-muted/50 p-3">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd className="text-lg font-semibold text-foreground" data-testid={props.testId}>
        {props.value}
      </dd>
      {props.sublabel && <dd className="text-xs text-muted-foreground">{props.sublabel}</dd>}
    </div>
  );
}
