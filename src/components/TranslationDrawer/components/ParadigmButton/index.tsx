'use client';

import { useEffect, useState } from 'react';
import { Table2, X } from 'lucide-react';
import ParadigmTables from '@/components/ParadigmTables';
import TargetText from '@/components/TargetText';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { fetchParadigm } from '@/lib/dictionary-client';
import type { Paradigm } from '@/lib/languages';

/** Header button that opens the word's declension or conjugation table, when it has one. */
export default function ParadigmButton({ word, enabled }: { word: string; enabled: boolean }) {
  const [loaded, setLoaded] = useState<{ word: string; paradigm: Paradigm | null } | null>(null);

  useEffect(() => {
    if (!enabled || !word.trim()) return;
    let cancelled = false;
    fetchParadigm(word).then((paradigm) => {
      if (!cancelled) setLoaded({ word, paradigm });
    });
    return () => {
      cancelled = true;
    };
  }, [word, enabled]);

  const paradigm = enabled && loaded?.word === word ? loaded.paradigm : null;
  if (!paradigm) return null;
  const label = paradigm.kind === 'verb' ? 'Conjugation' : 'Declension';

  return (
    <Dialog>
      <DialogTrigger
        className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={`${label} table`}
        title={`${label} table`}
        data-testid="paradigm-button"
      >
        <Table2 className="h-5 w-5" />
      </DialogTrigger>
      <DialogContent
        className="flex max-h-[85vh] max-w-2xl flex-col"
        data-testid="paradigm-dialog"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <DialogTitle>
            {label} of <TargetText>{paradigm.lemma}</TargetText>
          </DialogTitle>
          <DialogClose
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close table"
          >
            <X className="h-5 w-5" />
          </DialogClose>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <ParadigmTables paradigm={paradigm} highlight={word} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
