'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, LoaderCircle, X } from 'lucide-react';
import MicButton from '@/components/MicButton';
import ParadigmTables from '@/components/ParadigmTables';
import TargetText from '@/components/TargetText';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { lectorMode } from '@/lib/api-base';
import { isVoiceInputSupported } from '@/lib/stt';
import { useSpeechCapture } from '@/lib/stt/use-speech-capture';
import { useActiveLanguage } from '@/utils/hooks';
import {
  fetchFormsRound,
  FORMS_COUNT_KEY,
  FORMS_COUNT_OPTIONS,
  FORMS_KINDS_KEY,
  FORMS_MODE_KEY,
  FormsError,
  getFormsCount,
  getFormsKinds,
  getFormsMode,
  gradeForm,
  gradeSpokenForm,
  recordFormsAnswer,
  type FormsAnswerMode,
  type FormsGrade,
  type FormsItem,
  type FormsKind,
} from '../../forms';

type Status = 'setup' | 'loading' | 'question' | 'feedback' | 'summary';

interface Result {
  item: FormsItem;
  answer: string;
  grade: FormsGrade | 'revealed';
}

const KIND_LABELS: Record<FormsKind, string> = { noun: 'Nouns', verb: 'Verbs' };

export default function FormsPractice() {
  const pack = useActiveLanguage();
  const [status, setStatus] = useState<Status>('setup');
  const [kinds, setKinds] = useState<FormsKind[]>(['noun']);
  const [mode, setMode] = useState<FormsAnswerMode>('type');
  const [count, setCount] = useState(10);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [error, setError] = useState<FormsError | null>(null);
  const [items, setItems] = useState<FormsItem[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [showTable, setShowTable] = useState(false);
  const [heardNothing, setHeardNothing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const item = items[index];
  const result = results[index];

  useEffect(() => {
    const load = () => {
      const voice = lectorMode() === 'selfhost' && isVoiceInputSupported();
      setVoiceSupported(voice);
      setKinds(getFormsKinds());
      setMode(voice ? getFormsMode() : 'type');
      setCount(getFormsCount());
    };
    load();
  }, []);

  useEffect(() => {
    if (status === 'question' && mode === 'type') inputRef.current?.focus();
    if (status === 'feedback') nextRef.current?.focus();
  }, [status, index, mode]);

  const finish = (grade: Result['grade'], given: string) => {
    if (!item) return;
    setResults((prev) => {
      const next = [...prev];
      next[index] = { item, answer: given, grade };
      return next;
    });
    setShowTable(false);
    setStatus('feedback');
    recordFormsAnswer();
  };

  const speech = useSpeechCapture(pack.code, (transcript) => {
    setHeardNothing(!transcript.trim());
    if (!item || !transcript.trim()) return;
    finish(gradeSpokenForm(transcript, item.answers, pack) ? 'correct' : 'wrong', transcript);
  });

  const toggleKind = (kind: FormsKind) => {
    const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
    setKinds(next);
    if (next.length > 0) localStorage.setItem(FORMS_KINDS_KEY, next.join(','));
  };

  const start = async () => {
    setStatus('loading');
    setError(null);
    try {
      const round = await fetchFormsRound(kinds, count);
      setItems(round);
      setResults([]);
      setIndex(0);
      setAnswer('');
      setStatus('question');
    } catch (err) {
      setError(err instanceof FormsError ? err : new FormsError(String(err)));
      setStatus('setup');
    }
  };

  const submitTyped = () => {
    if (!item || !answer.trim()) return;
    finish(gradeForm(answer, item.answers, pack), answer.trim());
  };

  const next = () => {
    speech.cancel();
    setAnswer('');
    if (index + 1 >= items.length) setStatus('summary');
    else {
      setIndex(index + 1);
      setStatus('question');
    }
  };

  if (status === 'setup' || status === 'loading') {
    return (
      <div
        className="space-y-5 rounded-2xl border border-border bg-card p-5"
        data-testid="forms-setup"
      >
        <div>
          <h2 className="text-base font-semibold text-foreground">Forms</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            See a word in its dictionary form and a case or tense. Type or say the form it asks for.
          </p>
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-foreground">Words</legend>
          <div className="flex gap-4">
            {(['noun', 'verb'] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={kinds.includes(kind)}
                  onChange={() => toggleKind(kind)}
                  data-testid={`forms-kind-${kind}`}
                  className="h-4 w-4 accent-[var(--primary)]"
                />
                {KIND_LABELS[kind]}
              </label>
            ))}
          </div>
        </fieldset>

        {voiceSupported && (
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">Answer by</p>
            <div className="flex gap-2">
              {(['type', 'voice'] as const).map((m) => (
                <Button
                  key={m}
                  variant={mode === m ? 'default' : 'secondary'}
                  data-testid={`forms-mode-${m}`}
                  onClick={() => {
                    setMode(m);
                    localStorage.setItem(FORMS_MODE_KEY, m);
                  }}
                >
                  {m === 'type' ? 'Typing' : 'Speaking'}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-2 text-sm font-medium text-foreground">Words per round</p>
          <div className="flex gap-2">
            {FORMS_COUNT_OPTIONS.map((n) => (
              <Button
                key={n}
                variant={count === n ? 'default' : 'secondary'}
                data-testid={`forms-count-${n}`}
                onClick={() => {
                  setCount(n);
                  localStorage.setItem(FORMS_COUNT_KEY, String(n));
                }}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>

        {error && (
          <p className="text-sm text-destructive" data-testid="forms-error">
            {error.message}
          </p>
        )}
        <Button
          className="w-full"
          onClick={start}
          disabled={kinds.length === 0 || status === 'loading'}
          data-testid="forms-start"
        >
          {status === 'loading' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : 'Start'}
        </Button>
        {kinds.length === 0 && (
          <p className="text-xs text-muted-foreground">Choose nouns, verbs or both.</p>
        )}
      </div>
    );
  }

  if (status === 'summary') {
    const score = results.filter((r) => r.grade === 'correct' || r.grade === 'accent').length;
    return (
      <div
        className="space-y-4 rounded-2xl border border-border bg-card p-5"
        data-testid="forms-summary"
      >
        <h2 className="text-base font-semibold text-foreground">
          Round complete:{' '}
          <span data-testid="forms-score">
            {score}/{results.length}
          </span>
        </h2>
        <ul className="divide-y divide-border text-sm">
          {results.map((r, i) => {
            const right = r.grade === 'correct' || r.grade === 'accent';
            return (
              <li key={i} className="flex items-center gap-3 py-2">
                {right ? (
                  <Check className="h-4 w-4 shrink-0 text-primary" aria-label="correct" />
                ) : (
                  <X className="h-4 w-4 shrink-0 text-destructive" aria-label="wrong" />
                )}
                <TargetText className="font-medium">{r.item.lemma}</TargetText>
                <span className="text-muted-foreground">{r.item.prompt}</span>
                <TargetText className="ml-auto">{r.item.answers.join(', ')}</TargetText>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={start} data-testid="forms-again">
            New round
          </Button>
          <Button className="flex-1" variant="secondary" onClick={() => setStatus('setup')}>
            Change settings
          </Button>
        </div>
      </div>
    );
  }

  if (!item) return null;
  const answered = status === 'feedback' && result;
  const right = answered && (result.grade === 'correct' || result.grade === 'accent');

  return (
    <div className="space-y-4" data-testid="forms-practice">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span data-testid="forms-progress">
          {index + 1} of {items.length}
        </span>
        <span>
          {results.filter((r) => r && (r.grade === 'correct' || r.grade === 'accent')).length}{' '}
          correct
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${(results.filter(Boolean).length / items.length) * 100}%` }}
        />
      </div>

      <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
        <div className="text-center">
          <TargetText
            as="p"
            className="text-3xl font-semibold text-foreground"
            testId="forms-lemma"
          >
            {item.lemma}
          </TargetText>
          {item.gloss && (
            <p className="mt-1 text-sm text-muted-foreground italic" data-testid="forms-gloss">
              {item.gloss}
            </p>
          )}
          <p
            className="mt-3 inline-block rounded-full bg-[var(--primary-soft)] px-3 py-1 text-sm font-medium text-[var(--primary-text)]"
            data-testid="forms-prompt"
          >
            {item.prompt}
          </p>
        </div>

        {!answered && mode === 'type' && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitTyped();
            }}
          >
            <Input
              ref={inputRef}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={`The ${item.prompt} form`}
              aria-label={`The ${item.prompt} form of ${item.lemma}`}
              lang={pack.script.bcp47}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              data-testid="forms-input"
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                className="flex-1"
                disabled={!answer.trim()}
                data-testid="forms-check"
              >
                Check
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => finish('revealed', '')}
                data-testid="forms-reveal"
              >
                Show answer
              </Button>
            </div>
          </form>
        )}

        {!answered && mode === 'voice' && (
          <div className="flex flex-col items-center gap-3" data-testid="forms-voice">
            <MicButton
              phase={speech.phase}
              levelRef={speech.levelRef}
              onStart={() => {
                setHeardNothing(false);
                void speech.start();
              }}
              onStop={speech.stop}
              label="Say the form"
              testId="forms-mic"
            />
            <TargetText
              as="p"
              className="min-h-7 text-lg text-foreground"
              testId="forms-transcript"
            >
              {speech.transcript}
            </TargetText>
            {speech.error && <p className="text-sm text-destructive">{speech.error}</p>}
            {heardNothing && (
              <p className="text-sm text-muted-foreground">Didn&apos;t catch that. Try again.</p>
            )}
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  speech.cancel();
                  setMode('type');
                }}
              >
                Type instead
              </Button>
              <Button variant="ghost" size="sm" onClick={() => finish('revealed', '')}>
                Show answer
              </Button>
            </div>
          </div>
        )}

        {answered && (
          <div className="space-y-3" data-testid="forms-feedback">
            <p
              className={clsx('text-lg font-semibold', right ? 'text-primary' : 'text-destructive')}
              data-testid="forms-verdict"
            >
              {result.grade === 'correct'
                ? 'Correct'
                : result.grade === 'accent'
                  ? 'Correct, but check the spelling'
                  : result.grade === 'revealed'
                    ? 'Answer shown'
                    : 'Not quite'}
            </p>
            {result.answer && result.grade !== 'correct' && (
              <p className="text-sm text-muted-foreground">
                You said: <TargetText className="text-foreground">{result.answer}</TargetText>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {item.answers.length > 1 ? 'Forms: ' : 'Form: '}
              <TargetText className="text-base font-semibold text-foreground" testId="forms-answer">
                {item.answers.join(', ')}
              </TargetText>
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowTable((v) => !v)}
              data-testid="forms-toggle-table"
            >
              {showTable ? 'Hide table' : 'Show full table'}
            </Button>
            {showTable && <ParadigmTables paradigm={item.paradigm} highlight={item.answers[0]} />}
            <Button ref={nextRef} className="w-full" onClick={next} data-testid="forms-next">
              {index + 1 >= items.length ? 'See results' : 'Next'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
