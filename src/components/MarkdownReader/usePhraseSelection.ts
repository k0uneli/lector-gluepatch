'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { foldWord, tokenize, type LanguageConfig, type WordSegmentation } from '@/lib/languages';
import { usePhraseTouchSelection } from './usePhraseTouchSelection';
import { readableRangeText, snapToWordBoundaries } from './utils';

/**
 * The folded words of a phrase, with the pack's tokenizer: an unspaced script
 * has no spaces to split on (#213).
 */
export function phraseWords(
  text: string,
  pack: LanguageConfig,
  segmentation?: WordSegmentation | null,
): string[] {
  return tokenize(text, pack, segmentation)
    .filter((token) => token.isWord)
    .map((token) => foldWord(token.text, pack));
}

/**
 * Phrase selection inside `containerRef`: a mouse drag (attach the returned
 * handler as `onMouseUp`) or a long-press drag on touch. `onPhrase` gets the
 * selected text, snapped to whole words, and an element inside it; it fires
 * only for two or more words. `segmentation` must match the rendered words.
 */
export function usePhraseSelection(
  containerRef: RefObject<HTMLElement | null>,
  pack: LanguageConfig,
  segmentation: WordSegmentation | null,
  onPhrase: (text: string, element: HTMLElement | null) => void,
): () => void {
  const onPhraseRef = useRef(onPhrase);
  useEffect(() => {
    onPhraseRef.current = onPhrase;
  }, [onPhrase]);

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const raw = selection.toString().trim();
    if (!raw || phraseWords(raw, pack, segmentation).length < 2) return;
    const snapped = snapToWordBoundaries(selection, pack, segmentation);
    if (snapped) onPhraseRef.current(snapped, selection.anchorNode?.parentElement ?? null);
  }, [pack, segmentation]);

  // The touch gesture reports its end words, so the text comes from the DOM
  // between them, keeping the rendered spacing of an unspaced script.
  const handleTouchPhrase = useCallback((first: HTMLElement, last: HTMLElement) => {
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    onPhraseRef.current(readableRangeText(range).trim(), first);
  }, []);

  usePhraseTouchSelection(containerRef, handleTouchPhrase);
  return handleMouseUp;
}
