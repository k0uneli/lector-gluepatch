'use client';

import { Check, X } from 'lucide-react';
import TargetText from '@/components/TargetText';
import type { RecallItem } from '@/lib/recall';

export default function RecallSummary({ items }: { items: RecallItem[] }) {
  const score = items.filter((i) => i.correct).length;
  return (
    <div className="space-y-5" data-testid="recall-summary">
      <div className="rounded-2xl border border-border bg-card p-5 text-center">
        <p className="text-sm text-muted-foreground">Today’s score</p>
        <p className="text-4xl font-bold text-foreground" data-testid="recall-score">
          {score}/{items.length}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">New sentences arrive tomorrow.</p>
      </div>
      <ol className="space-y-3">
        {items.map((item) => (
          <li key={item.idx} className="flex gap-3 rounded-xl border border-border bg-card p-4">
            {item.correct ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            ) : (
              <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 space-y-1">
              <p className="text-sm text-foreground">{item.english}</p>
              {item.answer && (
                <TargetText as="p" className="text-sm text-muted-foreground">
                  {item.answer}
                </TargetText>
              )}
              <TargetText as="p" className="text-sm font-medium text-foreground">
                {item.reference}
              </TargetText>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
