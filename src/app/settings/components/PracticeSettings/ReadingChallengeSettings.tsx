'use client';

import { useEffect, useState } from 'react';
import { Slider } from '@/components/ui/slider';
import {
  getReadingNewPercent,
  getReadingWords,
  READING_MAX_NEW_PERCENT,
  READING_MAX_WORDS,
  READING_MIN_WORDS,
  READING_NEW_PERCENT_KEY,
  READING_WORDS_KEY,
  READING_WORDS_STEP,
} from '@/lib/reading-challenge';

const first = (value: number | readonly number[]) => (Array.isArray(value) ? value[0] : value);

export default function ReadingChallengeSettings() {
  const [newPercent, setNewPercent] = useState<number | null>(null);
  const [words, setWords] = useState<number | null>(null);

  useEffect(() => {
    const load = () => {
      setNewPercent(getReadingNewPercent());
      setWords(getReadingWords());
    };
    load();
  }, []);

  if (newPercent === null || words === null) return null;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-baseline justify-between">
          <label id="reading-new-percent-label" className="text-sm font-medium text-foreground">
            New vocabulary
          </label>
          <span className="text-sm text-muted-foreground" data-testid="reading-new-percent-value">
            {newPercent}%
          </span>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          The share of words in the daily text that you have not marked yet. Around 5% keeps a text
          readable without a dictionary on every line.
        </p>
        <Slider
          value={[newPercent]}
          min={0}
          max={READING_MAX_NEW_PERCENT}
          step={1}
          aria-labelledby="reading-new-percent-label"
          data-testid="reading-new-percent-slider"
          onValueChange={(value) => {
            const next = first(value);
            setNewPercent(next);
            localStorage.setItem(READING_NEW_PERCENT_KEY, String(next));
          }}
        />
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label id="reading-words-label" className="text-sm font-medium text-foreground">
            Text length
          </label>
          <span className="text-sm text-muted-foreground" data-testid="reading-words-value">
            {words} words
          </span>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          About how many words the daily text has. Changes apply from the next text.
        </p>
        <Slider
          value={[words]}
          min={READING_MIN_WORDS}
          max={READING_MAX_WORDS}
          step={READING_WORDS_STEP}
          aria-labelledby="reading-words-label"
          data-testid="reading-words-slider"
          onValueChange={(value) => {
            const next = first(value);
            setWords(next);
            localStorage.setItem(READING_WORDS_KEY, String(next));
          }}
        />
      </div>
    </div>
  );
}
