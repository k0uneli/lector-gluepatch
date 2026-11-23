'use client';

import { useState } from 'react';
import { AudioLines, Trash2 } from 'lucide-react';
import TargetText from '@/components/TargetText';
import { Button } from '@/components/ui/button';
import type { ChatSummary } from '@/lib/conversation';

const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** Saved conversations, newest first, each with a two-step delete. */
export default function ChatList({
  chats,
  onOpen,
  onDelete,
}: {
  chats: ChatSummary[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (chats.length === 0) return null;
  return (
    <section className="mt-6" data-testid="conversation-history">
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Past conversations
      </h2>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
        {chats.map((chat) => (
          <li key={chat.id} className="flex items-center gap-2 px-4 py-3" data-testid="conversation-history-item">
            <button
              type="button"
              onClick={() => onOpen(chat.id)}
              className="min-w-0 flex-1 text-left"
              data-testid="conversation-history-open"
            >
              <span className="block truncate text-sm font-medium text-foreground">
                {chat.topic || <TargetText>{chat.preview}</TargetText>}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {dateFormat.format(new Date(chat.updatedAt))} · {chat.messageCount} messages
                {chat.recording && (
                  <AudioLines className="h-3.5 w-3.5" aria-label="has a recording" />
                )}
              </span>
            </button>
            {confirming === chat.id ? (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setConfirming(null);
                    onDelete(chat.id);
                  }}
                  data-testid="conversation-history-confirm-delete"
                >
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                  Keep
                </Button>
              </div>
            ) : (
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setConfirming(chat.id)}
                aria-label="Delete conversation"
                data-testid="conversation-history-delete"
              >
                <Trash2 />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
