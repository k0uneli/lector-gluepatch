'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { SETTINGS_KEYS } from '../../constants';
import { getRecallDailyCount, RECALL_COUNT_KEY, RECALL_COUNT_OPTIONS } from '@/lib/recall';

export default function PracticeSettings() {
  const [hideTranslation, setHideTranslation] = useState(false);
  const [recallCount, setRecallCount] = useState<number | null>(null);

  useEffect(() => {
    const load = () => {
      setHideTranslation(localStorage.getItem(SETTINGS_KEYS.HIDE_TRANSLATION) === 'true');
      setRecallCount(getRecallDailyCount());
    };
    load();
  }, []);

  const handleRecallCountChanged = (count: number) => {
    setRecallCount(count);
    localStorage.setItem(RECALL_COUNT_KEY, String(count));
  };

  const handleHideTranslationChanged = (hide: boolean) => {
    setHideTranslation(hide);
    localStorage.setItem(SETTINGS_KEYS.HIDE_TRANSLATION, String(hide));
  };

  return (
    <section className="panel p-6">
      <h2 className="mb-4 text-lg font-semibold text-foreground">Practice</h2>

      {/* Cloze settings sub-section */}
      <h3 className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Cloze settings
      </h3>
      <div>
        <label className="block text-sm font-medium text-foreground">Translation</label>
        <p className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Hide the English translation by default while practicing. Toggle it anytime with
          <KbdGroup>
            <Kbd>Alt</Kbd>
            <Kbd>T</Kbd>
          </KbdGroup>
          .
        </p>
        <div className="flex gap-2">
          <Button
            onClick={() => handleHideTranslationChanged(false)}
            variant={hideTranslation ? 'secondary' : 'default'}
          >
            Shown
          </Button>
          <Button
            onClick={() => handleHideTranslationChanged(true)}
            variant={hideTranslation ? 'default' : 'secondary'}
          >
            Hidden
          </Button>
        </div>
      </div>

      <h3 className="mt-6 mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Recall settings
      </h3>
      <div>
        <label className="block text-sm font-medium text-foreground">Sentences per day</label>
        <p className="mb-2 text-xs text-muted-foreground">
          How many sentences the daily recall challenge gives you. Once today&apos;s set has
          started, its size stays fixed until tomorrow.
        </p>
        <div className="flex gap-2">
          {RECALL_COUNT_OPTIONS.map((count) => (
            <Button
              key={count}
              data-testid={`recall-count-${count}`}
              onClick={() => handleRecallCountChanged(count)}
              variant={recallCount === count ? 'default' : 'secondary'}
            >
              {count}
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}
