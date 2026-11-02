'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { getAllCollections } from '@/lib/data-layer';
import { activeTenantId } from '@/lib/language-cache';
import { FEED_TOKEN_STORAGE_KEY, getPodcasts, type PodcastOverview } from '@/lib/podcast';
import type { Collection } from '@/types';
import { useActiveLanguage } from '@/utils/hooks';
import FeedPanel from './components/FeedPanel';
import NewEpisode from './components/NewEpisode';
import ShowList from './components/ShowList';

const POLL_MS = 4000;

function feedTokenKey(): string {
  return `${FEED_TOKEN_STORAGE_KEY}:${activeTenantId() ?? 'local'}`;
}

function readFeedToken(): string | null {
  try {
    return localStorage.getItem(feedTokenKey());
  } catch {
    return null;
  }
}

function writeFeedToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(feedTokenKey(), token);
    else localStorage.removeItem(feedTokenKey());
  } catch {
    /* storage unavailable: the URL is shown only for this visit */
  }
}

interface Loaded {
  language: string;
  overview: PodcastOverview;
  collections: Collection[];
}

export default function PodcastPage() {
  const pack = useActiveLanguage();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedToken, setFeedToken] = useState<string | null>(readFeedToken);

  const current = loaded?.language === pack.code ? loaded : null;
  const overview = current?.overview ?? null;
  const collections = current?.collections ?? null;

  const refresh = useCallback(async () => {
    try {
      const next = await getPodcasts();
      setLoaded((prev) => (prev ? { ...prev, overview: next } : prev));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPodcasts(), getAllCollections()])
      .then(([podcasts, all]) => {
        if (cancelled) return;
        setLoaded({ language: pack.code, overview: podcasts, collections: all });
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pack.code]);

  const generating = overview?.shows.some((show) =>
    show.episodes.some((e) => e.status === 'pending' || e.status === 'generating'),
  );
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [generating, refresh]);

  const onToken = (token: string | null) => {
    writeFeedToken(token);
    setFeedToken(token);
    void refresh();
  };

  const showCollections = new Set(overview?.shows.map((s) => s.collectionId));
  const sources = (collections ?? []).filter((c) => !showCollections.has(c.id));

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8 pb-24 sm:px-6 sm:pb-8 lg:px-8">
      <PageHeader title="Podcast" />
      {error && (
        <p className="text-sm text-destructive" data-testid="podcast-load-error">
          {error}
        </p>
      )}
      {!overview || !collections ? (
        !error && (
          <div className="flex justify-center py-12">
            <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )
      ) : (
        <>
          {!overview.workerEnabled && (
            <p
              className="rounded-xl border border-border bg-muted/50 p-3 text-sm text-muted-foreground"
              data-testid="podcast-worker-off"
            >
              The podcast generator is off on this server, so new episodes wait. Set{' '}
              <code className="rounded bg-muted px-1">PODCAST_WORKER=1</code> and restart Lector.
            </p>
          )}
          {sources.length === 0 ? (
            <section
              className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground"
              data-testid="podcast-no-books"
            >
              There is nothing to read yet. Import an EPUB or add a text in the{' '}
              <Link href="/" className="text-primary hover:underline">
                Library
              </Link>
              , then make an episode from one of its chapters.
            </section>
          ) : (
            <NewEpisode overview={overview} collections={sources} onCreated={refresh} />
          )}
          <ShowList
            shows={overview.shows}
            feedToken={overview.feed.hasToken ? feedToken : null}
            onChange={refresh}
          />
          {overview.feed.available && (
            <FeedPanel
              hasToken={overview.feed.hasToken}
              knownToken={overview.feed.hasToken ? feedToken : null}
              onToken={onToken}
            />
          )}
        </>
      )}
    </main>
  );
}
