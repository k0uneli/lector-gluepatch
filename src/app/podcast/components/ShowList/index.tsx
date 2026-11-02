'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Download, Headphones, Link2, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react';
import TargetText from '@/components/TargetText';
import { Button, buttonVariants } from '@/components/ui/button';
import { formatClock } from '@/components/ListenAlong/utils';
import { lessonAudioUrl } from '@/lib/data-layer';
import {
  deletePodcast,
  PODCAST_ENGINE_LABELS,
  podcastFeedUrl,
  retryPodcast,
  type PodcastEpisode,
  type PodcastShow,
} from '@/lib/podcast';

const STATUS_LABEL: Record<PodcastEpisode['status'], string> = {
  pending: 'Waiting',
  generating: 'Generating',
  done: 'Ready',
  error: 'Failed',
};

function EpisodeRow({ episode, onChange }: { episode: PodcastEpisode; onChange: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const inProgress = episode.status === 'pending' || episode.status === 'generating';
  const percent = Math.round((100 * episode.paraDone) / Math.max(1, episode.paraTotal));

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 rounded-xl border border-border p-3" data-testid="podcast-episode">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground" data-testid="podcast-episode-title">
            <TargetText>{episode.title}</TargetText>
          </p>
          <p className="text-xs text-muted-foreground">
            <span data-testid="podcast-episode-status">{STATUS_LABEL[episode.status]}</span>
            {' · '}
            {episode.paraDone} of {episode.paraTotal}{' '}
            {episode.paraTotal === 1 ? 'paragraph' : 'paragraphs'}
            {episode.durationMs > 0 && ` · ${formatClock(episode.durationMs)}`}
            {' · '}
            {PODCAST_ENGINE_LABELS[episode.engine]}
          </p>
        </div>
        {inProgress && (
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>

      {inProgress && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Generation progress"
        >
          <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
        </div>
      )}
      {episode.status === 'error' && episode.error && (
        <p className="text-xs text-destructive" data-testid="podcast-episode-error">
          {episode.error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {episode.paraDone > 0 && (
          <Link
            href={`/read/${episode.lessonId}`}
            className={buttonVariants({ size: 'sm' })}
            data-testid="podcast-listen"
          >
            <Headphones />
            Listen
          </Link>
        )}
        {episode.status === 'done' && (
          <a
            href={lessonAudioUrl(episode.lessonId)}
            download={`${episode.title}.mp3`}
            className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            data-testid="podcast-download"
          >
            <Download />
            MP3
          </a>
        )}
        {episode.status === 'error' && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => run(() => retryPodcast(episode.id))}
            data-testid="podcast-retry"
          >
            <RotateCcw />
            Retry
          </Button>
        )}
        <Button
          size="sm"
          variant={confirmDelete ? 'destructive' : 'ghost'}
          disabled={busy}
          onClick={() =>
            confirmDelete ? run(() => deletePodcast(episode.id)) : setConfirmDelete(true)
          }
          onBlur={() => setConfirmDelete(false)}
          data-testid="podcast-delete"
        >
          <Trash2 />
          {confirmDelete ? 'Delete episode?' : 'Delete'}
        </Button>
      </div>
    </li>
  );
}

export default function ShowList({
  shows,
  feedToken,
  onChange,
}: {
  shows: PodcastShow[];
  /** The feed token, when this device knows it. */
  feedToken: string | null;
  onChange: () => void;
}) {
  const copyFeed = async (showId: string) => {
    if (!feedToken) return;
    const url = podcastFeedUrl(feedToken, showId);
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Feed URL copied');
    } catch {
      toast.message(url);
    }
  };

  if (shows.length === 0) {
    return (
      <p
        className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
        data-testid="podcast-empty"
      >
        No episodes yet. Make one from a chapter above.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {shows.map((show) => (
        <section
          key={show.id}
          className="space-y-3 rounded-2xl border border-border bg-card p-5"
          data-testid="podcast-show"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {show.coverUrl && (
                <img
                  src={show.coverUrl}
                  alt=""
                  className="h-12 w-9 shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0">
                <h3
                  className="truncate font-semibold text-foreground"
                  data-testid="podcast-show-title"
                >
                  <TargetText>{show.title}</TargetText>
                </h3>
                <p className="truncate text-xs text-muted-foreground">{show.author}</p>
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              {feedToken && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => copyFeed(show.id)}
                  data-testid="podcast-copy-feed"
                >
                  <Link2 />
                  Feed URL
                </Button>
              )}
              <Link
                href={`/collection/${show.collectionId}`}
                className={buttonVariants({ size: 'sm', variant: 'ghost' })}
              >
                Collection
              </Link>
            </div>
          </div>
          <ul className="space-y-2">
            {show.episodes.map((episode) => (
              <EpisodeRow key={episode.id} episode={episode} onChange={onChange} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
