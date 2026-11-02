'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Podcast } from 'lucide-react';
import TargetText from '@/components/TargetText';
import { Button } from '@/components/ui/button';
import { getLessonsForCollection } from '@/lib/data-layer';
import {
  createPodcast,
  estimatePodcast,
  formatMinutes,
  PODCAST_ENGINE_LABELS,
  PODCAST_ENGINES,
  paragraphChoices,
  PodcastError,
  type PodcastEngineId,
  type PodcastEstimate,
  type PodcastOverview,
} from '@/lib/podcast';
import type { Collection, LessonSummary } from '@/types';

const selectClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:opacity-60';

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
}

export default function NewEpisode({
  overview,
  collections,
  onCreated,
}: {
  overview: PodcastOverview;
  collections: Collection[];
  onCreated: () => void;
}) {
  const [collectionId, setCollectionId] = useState('');
  const [chapters, setChapters] = useState<LessonSummary[]>([]);
  const [lessonId, setLessonId] = useState('');
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [estimate, setEstimate] = useState<PodcastEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [engine, setEngine] = useState<PodcastEngineId | null>(overview.defaultEngine);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The range the shown estimate is for, so filling in the range after a
  // whole-chapter estimate does not ask again.
  const estimatedKey = useRef('');

  useEffect(() => {
    let cancelled = false;
    setChapters([]);
    setLessonId('');
    setRange(null);
    setEstimate(null);
    estimatedKey.current = '';
    if (!collectionId) return;
    getLessonsForCollection(collectionId)
      .then((lessons) => {
        if (!cancelled) setChapters(lessons);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the chapters.');
      });
    return () => {
      cancelled = true;
    };
  }, [collectionId]);

  const from = range?.from;
  const to = range?.to;
  useEffect(() => {
    const key = `${lessonId}:${from ?? ''}:${to ?? ''}`;
    if (!lessonId || key === estimatedKey.current) return;
    let cancelled = false;
    setEstimate(null);
    setError(null);
    setEstimating(true);
    estimatePodcast({ lessonId, from, to })
      .then((result) => {
        if (cancelled) return;
        estimatedKey.current = `${lessonId}:${result.from}:${result.to}`;
        setEstimate(result);
        setRange({ from: result.from, to: result.to });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setEstimating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lessonId, from, to]);

  const chooseChapter = (id: string) => {
    estimatedKey.current = '';
    setEstimate(null);
    setRange(null);
    setLessonId(id);
  };

  const chooseRange = (from: number, to: number) => {
    setRange({ from, to: Math.max(from, to) });
  };

  const generate = async () => {
    if (!lessonId || !engine || !range) return;
    setCreating(true);
    setError(null);
    try {
      await createPodcast({ lessonId, from: range.from, to: range.to, engine });
      onCreated();
    } catch (err) {
      setError(err instanceof PodcastError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const choices = paragraphChoices(estimate?.paragraphCount ?? 0);
  const anyEngine = PODCAST_ENGINES.some((id) => overview.engines[id].configured);

  return (
    <section
      className="space-y-4 rounded-2xl border border-border bg-card p-5"
      data-testid="podcast-new"
    >
      <div>
        <h2 className="text-base font-semibold text-foreground">New episode</h2>
        <p className="text-sm text-muted-foreground">
          Choose a chapter. Each sentence is read slowly, then the words you don’t know yet are
          explained in English, with grammar and figures of speech. Each paragraph ends with a
          normal-speed reading.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor="podcast-collection"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            Book
          </label>
          <select
            id="podcast-collection"
            value={collectionId}
            onChange={(e) => setCollectionId(e.target.value)}
            className={selectClass}
            data-testid="podcast-collection"
          >
            <option value="">Choose a book…</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="podcast-chapter"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            Chapter
          </label>
          <select
            id="podcast-chapter"
            value={lessonId}
            onChange={(e) => chooseChapter(e.target.value)}
            disabled={chapters.length === 0}
            className={selectClass}
            data-testid="podcast-chapter"
          >
            <option value="">Choose a chapter…</option>
            {chapters.map((lesson) => (
              <option key={lesson.id} value={lesson.id}>
                {lesson.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {estimate && range && (
        <div className="space-y-3" data-testid="podcast-range">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="podcast-from"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                From paragraph
              </label>
              <select
                id="podcast-from"
                value={range.from}
                onChange={(e) => chooseRange(Number(e.target.value), range.to)}
                className={selectClass}
                data-testid="podcast-from"
              >
                {choices.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="podcast-to"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                To paragraph
              </label>
              <select
                id="podcast-to"
                value={range.to}
                onChange={(e) => chooseRange(range.from, Number(e.target.value))}
                className={selectClass}
                data-testid="podcast-to"
              >
                {choices
                  .filter((n) => n >= range.from)
                  .map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div className="space-y-1 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">¶{estimate.from}:</span>{' '}
              <TargetText>{preview(estimate.preview.first)}</TargetText>
            </p>
            {estimate.to !== estimate.from && (
              <p>
                <span className="font-medium text-foreground">¶{estimate.to}:</span>{' '}
                <TargetText>{preview(estimate.preview.last)}</TargetText>
              </p>
            )}
          </div>
          <p className="text-sm text-foreground" data-testid="podcast-estimate">
            About {formatMinutes(estimate.minutes)} of audio: {estimate.paragraphs}{' '}
            {estimate.paragraphs === 1 ? 'paragraph' : 'paragraphs'}, {estimate.unknownWords}{' '}
            {estimate.unknownWords === 1 ? 'word' : 'words'} to explain, about{' '}
            {estimate.characters.toLocaleString()} characters of speech.
          </p>
        </div>
      )}
      {estimating && !estimate && (
        <LoaderCircle
          className="h-5 w-5 animate-spin text-muted-foreground"
          aria-label="Estimating"
        />
      )}

      <div>
        <p className="mb-1 text-sm font-medium text-foreground">Voice</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Voice engine">
          {PODCAST_ENGINES.map((id) => (
            <Button
              key={id}
              type="button"
              role="radio"
              aria-checked={engine === id}
              variant={engine === id ? 'default' : 'secondary'}
              disabled={!overview.engines[id].configured}
              title={overview.engines[id].reason}
              onClick={() => setEngine(id)}
              data-testid={`podcast-engine-${id}`}
            >
              {PODCAST_ENGINE_LABELS[id]}
            </Button>
          ))}
        </div>
        {!anyEngine ? (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="podcast-no-engine">
            No voice engine is set up. {overview.engines.google.reason}.{' '}
            <Link href="/settings" className="text-primary hover:underline">
              Settings
            </Link>{' '}
            lists what each engine needs.
          </p>
        ) : (
          PODCAST_ENGINES.filter((id) => !overview.engines[id].configured).map((id) => (
            <p key={id} className="mt-1 text-xs text-muted-foreground">
              {PODCAST_ENGINE_LABELS[id]}: {overview.engines[id].reason}.
            </p>
          ))
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive" data-testid="podcast-error">
          {error}
        </p>
      )}

      <Button
        onClick={generate}
        disabled={!estimate || !engine || creating}
        className="w-full"
        data-testid="podcast-generate"
      >
        {creating ? <LoaderCircle className="animate-spin" /> : <Podcast />}
        Make the episode
      </Button>
    </section>
  );
}
