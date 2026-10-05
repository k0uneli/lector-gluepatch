import TargetText from '@/components/TargetText';
import type { ExpandedDictionaryEntry } from '../../types';
import Gloss from '../Gloss';
import NestedWordButton from '../NestedWordButton';

/** The senses of the lemmas a form-of entry names ("слышу" → слышать: to hear). */
export default function LemmaSenses({
  lemmaEntries,
  onLookupWord,
}: {
  lemmaEntries: NonNullable<ExpandedDictionaryEntry['lemmaEntries']>;
  onLookupWord?: (word: string) => void;
}) {
  return (
    <div className="mt-3 space-y-3 border-l-2 border-border pl-3" data-testid="lemma-entries">
      {lemmaEntries.map((lemma) => (
        <div key={lemma.word}>
          <p className="text-sm">
            {onLookupWord ? (
              <NestedWordButton
                word={lemma.word}
                onLookupWord={onLookupWord}
                testId="lemma-entry-link"
              />
            ) : (
              <TargetText className="font-medium text-foreground" as="span">
                {lemma.word}
              </TargetText>
            )}
          </p>
          <ol className="mt-1 space-y-1">
            {lemma.senses.map((sense, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="mt-0.5 flex-shrink-0 text-xs text-muted-foreground tabular-nums">
                  {i + 1}.
                </span>
                <div className="min-w-0 flex-1">
                  {sense.partOfSpeech && (
                    <span className="mr-2 inline-block rounded bg-muted px-1.5 py-0.5 align-middle text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      {sense.partOfSpeech}
                    </span>
                  )}
                  <span className="leading-relaxed text-foreground">
                    <Gloss text={sense.gloss} onLookupWord={onLookupWord} />
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
