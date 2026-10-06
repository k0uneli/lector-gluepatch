import { addFormattedNote, addWordCard } from '@/lib/anki';
import { activeNoteFormat, loadAnkiNoteFormats, pickWordDefinitions } from '@/lib/anki-formats';
import { queueForAnki } from '@/lib/anki-queue';
import type { AnkiTransport } from '@/lib/anki-transport';
import { getVocabByText, markVocabPushedToAnki, saveVocab } from '@/lib/data-layer';
import { entryMeaning, type ExpandedDictionaryEntry } from '@/lib/dictionary-client';
import { foldWord, type LanguageConfig } from '@/lib/languages';
import { SETTINGS_KEYS } from '@/app/settings/constants';
import type { VocabEntry } from '@/types';

export interface PracticeWordLookup {
  word: string;
  translation: string | null;
  aiContextTranslation: string | null;
  aiStructured: {
    senses: Array<{ partOfSpeech: string; gloss: string }>;
    ipa?: string;
    etymology?: string;
    relatedForms?: Array<{ form: string; relation: string }>;
  } | null;
  dictEntry: ExpandedDictionaryEntry | null;
}

/** The word's vocab entry, created at level1 when it has none. */
async function ensureVocabEntry(
  word: string,
  sentence: string,
  translation: string,
  pack: LanguageConfig,
): Promise<VocabEntry> {
  const text = foldWord(word, pack);
  const existing = await getVocabByText(text);
  if (existing) return existing;
  const now = new Date();
  const entry: VocabEntry = {
    id: crypto.randomUUID(),
    text,
    type: 'word',
    sentence,
    translation,
    state: 'level1',
    stateUpdatedAt: now,
    reviewCount: 0,
    createdAt: now,
    pushedToAnki: false,
  };
  if ((await saveVocab(entry)) === null) throw new Error('Could not save the word to vocabulary');
  return entry;
}

/**
 * Add a word looked up in cloze practice as a word card. `sentence` is the
 * full sentence, never the blanked one the drawer shows.
 */
export async function addPracticeWordToAnki(
  lookup: PracticeWordLookup,
  sentence: string,
  transport: AnkiTransport,
  pack: LanguageConfig,
): Promise<{ audioFailed: boolean }> {
  const { definition, definition2 } = pickWordDefinitions(lookup);
  const meaning =
    lookup.aiContextTranslation ??
    (lookup.dictEntry?.senses.length ? entryMeaning(lookup.dictEntry, 1) : null) ??
    lookup.translation ??
    '';
  const entry = await ensureVocabEntry(lookup.word, sentence, lookup.translation ?? '', pack);

  if (transport === 'addon') {
    const result = await queueForAnki([
      { id: entry.id, cardType: 'word', word: lookup.word, translation: meaning, meaning },
    ]);
    if (result.failed.length > 0) throw new Error(result.failed[0].error);
    return { audioFailed: false };
  }

  const deckName = localStorage.getItem(SETTINGS_KEYS.ANKI_DECK_NAME) || pack.native;
  const format = activeNoteFormat(await loadAnkiNoteFormats(), pack.code, 'word');
  let noteId: number;
  let audioFailed = false;
  if (format) {
    const result = await addFormattedNote(
      deckName,
      format,
      { word: lookup.word, sentence, definition, definition2 },
      { audioText: lookup.word, language: pack.code, pack },
    );
    noteId = result.noteId;
    audioFailed = result.audioFailed;
  } else {
    noteId = await addWordCard(deckName, lookup.word, meaning, meaning);
  }
  await markVocabPushedToAnki(entry.id, noteId);
  return { audioFailed };
}
