import { SETTINGS_KEYS } from '@/app/settings/constants';
import type { WordSource } from '@/components/MarkdownReader/types';
import type { VocabEntry } from '@/types';
import { addFormattedNote, addWordCard, buildSourceLinkHtml, type AnkiAudioClip } from './anki';
import {
  activeNoteFormat,
  fieldsWithSource,
  loadAnkiNoteFormats,
  pickWordDefinitions,
  type AnkiNoteFormat,
} from './anki-formats';
import { queueForAnki } from './anki-queue';
import type { AnkiTransport } from './anki-transport';
import { getVocabByText, markVocabPushedToAnki, saveVocab } from './data-layer';
import { entryMeaning, type ExpandedDictionaryEntry } from './dictionary-client';
import { foldWord, type LanguageConfig } from './languages';

/** Deck names from Settings → Anki Integration; the word deck also takes Basic exports. */
export function ankiDeckNames(pack: LanguageConfig): { word: string; sentence: string } {
  return {
    word: localStorage.getItem(SETTINGS_KEYS.ANKI_DECK_NAME) || pack.native,
    sentence: localStorage.getItem(SETTINGS_KEYS.ANKI_CLOZE_DECK_NAME) || `${pack.native}::Cloze`,
  };
}

/** A new level1 vocab entry for `word`; a multi-word selection is a phrase. */
export function newVocabEntry(opts: {
  word: string;
  sentence: string;
  translation: string;
  pack: LanguageConfig;
  bookId?: string;
}): VocabEntry {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    text: foldWord(opts.word, opts.pack),
    type: opts.word.trim().includes(' ') ? 'phrase' : 'word',
    sentence: opts.sentence,
    translation: opts.translation,
    state: 'level1',
    stateUpdatedAt: now,
    reviewCount: 0,
    ...(opts.bookId ? { bookId: opts.bookId } : {}),
    createdAt: now,
    pushedToAnki: false,
  };
}

/** The word's vocab entry, saved at level1 when it has none. */
export async function ensureVocabEntry(
  opts: Parameters<typeof newVocabEntry>[0],
): Promise<VocabEntry> {
  const existing = await getVocabByText(foldWord(opts.word, opts.pack));
  if (existing) return existing;
  const entry = newVocabEntry(opts);
  if ((await saveVocab(entry)) === null) throw new Error('Could not save the word to vocabulary');
  return entry;
}

/** A looked-up word, as the reader and practice drawers hold it. */
export interface WordLookup {
  /** The word as displayed; the vocab key is its folded form. */
  word: string;
  /** The full sentence, never a blanked one. */
  sentence: string;
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

/**
 * `translation` is the in-context reading of the word; `meaning` its first
 * dictionary or AI sense. The built-in card and the add-on queue show both.
 */
export function wordCardTexts(lookup: Omit<WordLookup, 'word' | 'sentence'>): {
  translation: string;
  meaning: string;
} {
  return {
    translation: lookup.aiContextTranslation ?? lookup.translation ?? '',
    meaning:
      (lookup.dictEntry?.senses.length ? entryMeaning(lookup.dictEntry, 1) : null) ??
      lookup.aiStructured?.senses[0]?.gloss ??
      lookup.translation ??
      '',
  };
}

/**
 * Send a word card to Anki. `format` undefined loads the word format from
 * Settings; null forces the built-in card. With `source`, the card carries the
 * transcript link, and `getSentenceClip` supplies its Sentence audio.
 * `noteId` is null on the add-on transport, whose ack marks the entry pushed.
 */
export async function addWordCardToAnki(opts: {
  lookup: WordLookup;
  vocabEntryId: string;
  transport: AnkiTransport;
  pack: LanguageConfig;
  deckName?: string;
  format?: AnkiNoteFormat | null;
  source?: WordSource | null;
  getSentenceClip?: (startMs: number, endMs: number) => Promise<AnkiAudioClip | undefined>;
}): Promise<{ noteId: number | null; audioFailed: boolean }> {
  const { lookup, pack, source } = opts;
  const { translation, meaning } = wordCardTexts(lookup);

  if (opts.transport === 'addon') {
    const result = await queueForAnki([
      {
        id: opts.vocabEntryId,
        cardType: 'word',
        word: lookup.word,
        translation,
        meaning,
        ...(source
          ? { sourceUrl: source.sourceUrl, clipStartMs: source.startMs, clipEndMs: source.endMs }
          : {}),
      },
    ]);
    if (result.failed.length > 0) throw new Error(result.failed[0].error);
    return { noteId: null, audioFailed: false };
  }

  const deckName = opts.deckName ?? ankiDeckNames(pack).word;
  const format =
    opts.format === undefined
      ? activeNoteFormat(await loadAnkiNoteFormats(), pack.code, 'word')
      : opts.format;
  let noteId: number;
  let audioFailed = false;
  if (format) {
    const sentenceClip =
      source && opts.getSentenceClip && fieldsWithSource(format, 'sentenceAudio').length > 0
        ? await opts.getSentenceClip(source.startMs, source.endMs)
        : undefined;
    const result = await addFormattedNote(
      deckName,
      format,
      { word: lookup.word, sentence: lookup.sentence, ...pickWordDefinitions(lookup) },
      { audioText: lookup.word, sentenceClip, language: pack.code, pack },
    );
    noteId = result.noteId;
    audioFailed = result.audioFailed;
  } else {
    noteId = await addWordCard(
      deckName,
      lookup.word,
      translation,
      meaning,
      source ? buildSourceLinkHtml(source) || undefined : undefined,
    );
  }
  await markVocabPushedToAnki(opts.vocabEntryId, noteId);
  return { noteId, audioFailed };
}
