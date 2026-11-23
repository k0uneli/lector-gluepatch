'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import type { ExpandedDictionaryEntry } from '@/components/TranslationDrawer';
import { translateGloss, translateWord } from '@/lib/claude';
import {
  getActivePack,
  getVocabByText,
  getWordState,
  incrementDailyStat,
  saveVocab,
  updateVocabState,
} from '@/lib/data-layer';
import {
  cacheAcceptedTranslation,
  entryMeaning,
  lookupWordRemote,
} from '@/lib/dictionary-client';
import { foldWord } from '@/lib/languages';
import { splitTrailingPunctuation } from '@/lib/words';
import type { VocabEntry, WordState } from '@/types';

interface PanelState {
  word: string;
  sentence: string;
  dictEntry: ExpandedDictionaryEntry | null;
  translation: string | null;
  partOfSpeech: string | null;
  aiContextTranslation: string | null;
  existingEntry: VocabEntry | null;
  wordState: WordState | undefined;
  isLoading: boolean;
  isContextLoading: boolean;
  error: string | null;
}

/**
 * The definition drawer for a word outside the reader: dictionary first, then
 * an AI gloss, with the reader's level, known and ignore actions.
 */
export function useWordPanel() {
  const [panel, setPanel] = useState<PanelState | null>(null);
  const requestId = useRef(0);

  const open = useCallback(async (rawWord: string, sentence: string) => {
    const [word] = splitTrailingPunctuation(rawWord.trim());
    if (!word) return;
    const request = ++requestId.current;
    const key = foldWord(word, getActivePack());
    setPanel({
      word,
      sentence,
      dictEntry: null,
      translation: null,
      partOfSpeech: null,
      aiContextTranslation: null,
      existingEntry: null,
      wordState: undefined,
      isLoading: true,
      isContextLoading: false,
      error: null,
    });
    const [dictEntry, existingEntry, wordState] = await Promise.all([
      lookupWordRemote(word).catch(() => null),
      getVocabByText(key).catch(() => undefined),
      getWordState(word).catch(() => undefined),
    ]);
    if (request !== requestId.current) return;
    const base = { existingEntry: existingEntry ?? null, wordState };
    if (dictEntry && dictEntry.senses.length > 0) {
      setPanel((prev) =>
        prev && {
          ...prev,
          ...base,
          dictEntry,
          translation: entryMeaning(dictEntry),
          partOfSpeech: dictEntry.senses[0]?.partOfSpeech || null,
          isLoading: false,
        },
      );
      return;
    }
    try {
      const result = await translateGloss(word, sentence);
      if (request !== requestId.current) return;
      setPanel((prev) =>
        prev && {
          ...prev,
          ...base,
          translation: result.translation,
          partOfSpeech: result.partOfSpeech || null,
          isLoading: false,
        },
      );
    } catch {
      if (request !== requestId.current) return;
      setPanel((prev) =>
        prev && { ...prev, ...base, isLoading: false, error: 'Please try again.' },
      );
    }
  }, []);

  const close = useCallback(() => {
    requestId.current++;
    setPanel(null);
  }, []);

  const requestContextTranslation = useCallback(async () => {
    if (!panel) return;
    const request = requestId.current;
    setPanel((prev) => prev && { ...prev, isContextLoading: true });
    try {
      const result = await translateWord(panel.word, panel.sentence);
      if (request !== requestId.current) return;
      setPanel(
        (prev) =>
          prev && {
            ...prev,
            dictEntry: null,
            translation: result.translation,
            partOfSpeech: result.partOfSpeech || prev.partOfSpeech,
            aiContextTranslation: result.translation,
            isContextLoading: false,
          },
      );
    } catch {
      setPanel((prev) => prev && { ...prev, isContextLoading: false });
    }
  }, [panel]);

  const setState = useCallback(
    async (state: WordState, failure: string) => {
      if (!panel) return;
      const pack = getActivePack();
      let entry: VocabEntry;
      if (panel.existingEntry) {
        if (!(await updateVocabState(panel.existingEntry.id, state))) {
          toast.error(failure);
          return;
        }
        entry = { ...panel.existingEntry, state, stateUpdatedAt: new Date() };
      } else {
        entry = {
          id: uuidv4(),
          text: foldWord(panel.word, pack),
          type: 'word',
          sentence: panel.sentence,
          translation: panel.translation ?? '',
          state,
          stateUpdatedAt: new Date(),
          reviewCount: 0,
          createdAt: new Date(),
          pushedToAnki: false,
        };
        if (!(await saveVocab(entry))) {
          toast.error(failure);
          return;
        }
        if (state.startsWith('level')) void incrementDailyStat('newWordsSaved');
      }
      if (state === 'known') void incrementDailyStat('wordsMarkedKnown');
      if (!panel.dictEntry && panel.translation) {
        void cacheAcceptedTranslation({
          word: panel.word,
          senses: [{ partOfSpeech: panel.partOfSpeech ?? '', gloss: panel.translation }],
          sourceSentence: panel.sentence,
          language: pack.code,
        });
      }
      setPanel((prev) => prev && { ...prev, existingEntry: entry, wordState: state });
    },
    [panel],
  );

  const setLevel = useCallback(
    (level: 1 | 2 | 3 | 4) =>
      setState(`level${level}` as WordState, 'Could not set the word level. Check your connection.'),
    [setState],
  );
  const markKnown = useCallback(async () => {
    await setState('known', 'Could not mark the word as known. Check your connection.');
    close();
  }, [setState, close]);
  const ignore = useCallback(async () => {
    await setState('ignored', 'Could not ignore the word. Check your connection.');
    close();
  }, [setState, close]);

  return { panel, open, close, requestContextTranslation, setLevel, markKnown, ignore };
}
