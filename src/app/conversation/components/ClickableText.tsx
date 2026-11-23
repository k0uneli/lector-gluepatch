'use client';

import { useMemo } from 'react';
import clsx from 'clsx';
import { tokenize } from '@/lib/languages';
import { useActiveLanguage } from '@/utils/hooks';

/** The text as written, with every word a button that opens its definition. */
export default function ClickableText({
  text,
  onWord,
  className,
  wordClassName,
  testId,
}: {
  text: string;
  onWord: (word: string, sentence: string) => void;
  className?: string;
  wordClassName?: string;
  testId?: string;
}) {
  const pack = useActiveLanguage();
  const tokens = useMemo(() => tokenize(text, pack), [text, pack]);
  return (
    <p
      dir={pack.script.direction}
      lang={pack.script.bcp47}
      className={className}
      style={{ unicodeBidi: 'isolate' }}
      data-testid={testId}
    >
      {tokens.map((token, i) =>
        token.isWord ? (
          <button
            key={i}
            type="button"
            onClick={() => onWord(token.text, text)}
            aria-label={`Look up ${token.text}`}
            data-testid="conversation-word"
            className={clsx(
              'inline cursor-pointer rounded-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              wordClassName,
            )}
          >
            {token.text}
          </button>
        ) : (
          <span key={i}>{token.text}</span>
        ),
      )}
    </p>
  );
}
