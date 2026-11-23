'use client';

import { useState } from 'react';
import { AudioLines, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { chatRecordingUrl, type ChatSummary } from '@/lib/conversation';

/**
 * The whole conversation as one recording: your spoken turns and the
 * partner's voice, stitched on the server and kept until deleted.
 */
export default function RecordingPanel({
  chat,
  messageCount,
  canBuild,
  building,
  onBuild,
  onDelete,
}: {
  chat: ChatSummary;
  messageCount: number;
  canBuild: boolean;
  building: boolean;
  onBuild: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const recording = chat.recording;

  if (!recording) {
    return (
      <div className="mb-4 flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          onClick={onBuild}
          disabled={!canBuild || building || messageCount === 0}
          title={canBuild ? undefined : 'Set up a voice engine in Settings to build a recording'}
          data-testid="conversation-recording-build"
        >
          {building ? <LoaderCircle className="animate-spin" /> : <AudioLines />}
          {building ? 'Stitching the recording…' : 'Listen to the whole conversation'}
        </Button>
      </div>
    );
  }

  const stale = recording.messages < messageCount;
  return (
    <div
      className="mb-4 space-y-2 rounded-2xl border border-border bg-card p-3"
      data-testid="conversation-recording"
    >
      <audio
        controls
        preload="none"
        className="w-full"
        src={chatRecordingUrl(chat.id, `${recording.messages}-${recording.durationMs}`)}
        data-testid="conversation-recording-audio"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {Math.round(recording.durationMs / 1000)} s
          {stale && ` · covers ${recording.messages} of ${messageCount} messages`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {stale && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onBuild}
              disabled={!canBuild || building}
              data-testid="conversation-recording-update"
            >
              {building ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              Update
            </Button>
          )}
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirming(false);
                  onDelete();
                }}
                data-testid="conversation-recording-confirm-delete"
              >
                Delete recording
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(true)}
              data-testid="conversation-recording-delete"
            >
              <Trash2 />
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
