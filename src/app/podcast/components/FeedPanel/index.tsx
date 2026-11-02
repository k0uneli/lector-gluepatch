'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Rss } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createFeedToken, revokeFeedToken } from '@/lib/podcast';

export default function FeedPanel({
  hasToken,
  knownToken,
  onToken,
}: {
  hasToken: boolean;
  /** The token, when this device created it. */
  knownToken: string | null;
  onToken: (token: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    try {
      onToken(await action());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="space-y-3 rounded-2xl border border-border bg-card p-5"
      data-testid="podcast-feed"
    >
      <div className="flex items-center gap-2">
        <Rss className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold text-foreground">Podcast app feed</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Each book is a private podcast show. Add its feed URL to a podcast app to listen on your
        phone. The phone must be able to reach this Lector server, for example on the same network.
        Anyone with a feed URL can listen, so keep it private.
      </p>
      {!hasToken ? (
        <Button
          onClick={() => run(createFeedToken)}
          disabled={busy}
          data-testid="podcast-feed-enable"
        >
          Turn on the feed
        </Button>
      ) : (
        <>
          <p className="text-sm text-foreground" data-testid="podcast-feed-state">
            {knownToken
              ? 'The feed is on. Use “Feed URL” on a book to copy its address.'
              : 'The feed is on, but this device does not have its URLs. Reset the feed to show them here. The old URLs stop working.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => run(createFeedToken)}
              disabled={busy}
              data-testid="podcast-feed-reset"
            >
              Reset the feed URLs
            </Button>
            <Button
              variant="ghost"
              onClick={() => run(async () => (await revokeFeedToken(), null))}
              disabled={busy}
              data-testid="podcast-feed-disable"
            >
              Turn off the feed
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
