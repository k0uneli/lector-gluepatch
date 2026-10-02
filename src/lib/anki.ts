// AnkiConnect API client — direct browser-to-local connection.
// AnkiConnect must be running on localhost:8765 by default.
// In Anki: Tools > Add-ons > AnkiConnect > Config, ensure webCorsOriginList
// includes "*" or your app origin.
//
// The URL is overridable via the `ankiConnectUrl` setting so a user with a
// remote Anki install (e.g. over Tailscale) can point at http://100.x.x.x:8765.

import { splitTrailingPunctuation } from './words';
import { foldWord, wrapWholeWord, type LanguageConfig } from './languages';
import { getActivePack } from './data-layer';
import type { WordState } from '@/types';
import { apiFetch } from './api-base';
import {
  fieldsWithSource,
  isClozeFormat,
  loadAnkiNoteFormats,
  renderNoteFields,
  type AnkiCardContent,
  type AnkiFieldSource,
  type AnkiNoteFormat,
  type AnkiNoteFormats,
} from './anki-formats';
import { synthesizeSpeech } from './tts';

const DEFAULT_ANKI_CONNECT_URL = 'http://localhost:8765';

let _cachedUrl: string | null = null;
let _inflight: Promise<string> | null = null;

/**
 * Resolve the AnkiConnect URL, reading from /api/settings on first call and
 * caching the result. Call `refreshAnkiUrl()` after the user updates the
 * setting so the next request uses the new value.
 */
async function getAnkiUrl(): Promise<string> {
  if (_cachedUrl) return _cachedUrl;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const res = await apiFetch('/api/settings/ankiConnectUrl');
      if (res.ok) {
        const value = (await res.json()) as string | null | undefined;
        if (typeof value === 'string' && value.trim()) {
          _cachedUrl = value.trim();
          return _cachedUrl;
        }
      }
    } catch {
      // Fall through to default
    }
    _cachedUrl = DEFAULT_ANKI_CONNECT_URL;
    return _cachedUrl;
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

/** Invalidate the cached URL so the next AnkiConnect call re-reads the setting. */
export function refreshAnkiUrl(): void {
  _cachedUrl = null;
  _inflight = null;
}

interface AnkiConnectResponse<T = unknown> {
  result: T;
  error: string | null;
}

interface CardInfo {
  cardId: number;
  fields: Record<string, { value: string; order: number }>;
  interval: number;
  // 0 = New, 1 = Learning, 2 = Review (Young/Mature), 3 = Relearning
  type: number;
  note: number;
  deckName: string;
  modelName: string;
}

// Rank used for upgrade-only sync (ignored shares known's rank so it is never overridden).
const STATE_RANK: Record<WordState, number> = {
  new: 0,
  level1: 1,
  level2: 2,
  level3: 3,
  level4: 4,
  known: 5,
  ignored: 5,
};

/**
 * Map a raw Anki card (type + interval) to a lector vocab state, or `null` when
 * the card carries no learning signal yet. A New card is queued in Anki but has
 * never been studied, so the sync ignores it entirely — it neither upgrades an
 * existing entry nor imports a new word.
 *
 * New (0)            → null     — queued but not yet studied; ignored
 * Learning (1)       → level1   — in initial learning steps
 * Relearning (3)     → level2   — lapsed, being relearned
 * Young (2, < 21 d)  → level4   — graduated to review, almost known
 * Mature (2, ≥ 21 d) → known    — stable long-term recall; treat as known
 */
export function ankiCardToState(type: number, interval: number): WordState | null {
  if (type === 0) return null;
  if (type === 1) return 'level1';
  if (type === 3) return 'level2';
  return interval >= 21 ? 'known' : 'level4';
}

/**
 * Given existing vocab entries and the Anki state map, find Anki words that
 * have no matching entry in lector yet. Returns them ready to be created.
 *
 * Pure function — no side effects, easily unit-testable.
 */
export function findNewAnkiWords(
  existingEntries: ReadonlyArray<{ text: string }>,
  ankiStates: ReadonlyMap<
    string,
    { type: number; interval: number; sentence: string; translation: string }
  >,
): Array<{ text: string; state: WordState; sentence: string; translation: string }> {
  const existingWords = new Set(existingEntries.map((e) => e.text.toLowerCase()));
  const newWords: Array<{ text: string; state: WordState; sentence: string; translation: string }> =
    [];
  for (const [word, data] of ankiStates) {
    if (existingWords.has(word)) continue;
    const state = ankiCardToState(data.type, data.interval);
    if (!state) continue; // New card → don't import an unstudied word
    newWords.push({
      text: word,
      state,
      sentence: data.sentence,
      translation: data.translation,
    });
  }
  return newWords;
}

/**
 * Given existing vocab entries and the Anki state map, compute which entries
 * should be upgraded. Only returns entries that would move to a higher state;
 * never demotes, and always skips `ignored` entries.
 *
 * Pure function — no side effects, easily unit-testable.
 */
export function reconcileAnkiStates(
  entries: ReadonlyArray<{ id: string; text: string; state: WordState }>,
  ankiStates: ReadonlyMap<string, { type: number; interval: number }>,
): Array<{ id: string; newState: WordState }> {
  const updates: Array<{ id: string; newState: WordState }> = [];
  for (const entry of entries) {
    if (entry.state === 'ignored') continue;
    const ankiData = ankiStates.get(entry.text.toLowerCase());
    if (!ankiData) continue;
    const newState = ankiCardToState(ankiData.type, ankiData.interval);
    if (!newState) continue; // New card → no learning signal, leave entry as-is
    if (STATE_RANK[newState] > STATE_RANK[entry.state]) {
      updates.push({ id: entry.id, newState });
    }
  }
  return updates;
}

/**
 * Make a request directly to AnkiConnect on localhost
 */
async function ankiRequest<T>(action: string, params?: Record<string, unknown>): Promise<T> {
  const url = await getAnkiUrl();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
  });

  if (!response.ok) {
    throw new Error(`AnkiConnect error: ${response.status}`);
  }

  const data = (await response.json()) as AnkiConnectResponse<T>;

  if (data.error) {
    throw new Error(`AnkiConnect error: ${data.error}`);
  }

  return data.result;
}

/**
 * Check if Anki is running and AnkiConnect is available
 */
export async function isAnkiConnected(): Promise<boolean> {
  try {
    const url = await getAnkiUrl();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'version', version: 6 }),
    });
    const data = await response.json();
    return data.result != null && data.error == null;
  } catch {
    return false;
  }
}

/**
 * Get all deck names from Anki
 */
export async function getDeckNames(): Promise<string[]> {
  return ankiRequest<string[]>('deckNames');
}

/** Every note type in the user's collection. */
export async function getModelNames(): Promise<string[]> {
  return ankiRequest<string[]>('modelNames');
}

export async function getModelFieldNames(modelName: string): Promise<string[]> {
  return ankiRequest<string[]>('modelFieldNames', { modelName });
}

/**
 * Create a deck if it doesn't exist
 * @param deckName - Name of the deck to create
 */
async function ensureDeckExists(deckName: string): Promise<void> {
  await ankiRequest('createDeck', { deck: deckName });
}

/**
 * Add a basic (front/back) card to Anki
 * @param deckName - Name of the deck to add the card to
 * @param sentence - The Afrikaans sentence containing the target word
 * @param targetWord - The word being learned
 * @param translation - English translation of the sentence
 * @param wordMeaning - English meaning of the target word
 * @returns The note ID of the created card
 */
export async function addBasicCard(
  deckName: string,
  sentence: string,
  targetWord: string,
  translation: string,
  wordMeaning: string,
  pack?: LanguageConfig,
): Promise<number> {
  console.log(`[Anki] Adding basic card to deck "${deckName}" for word "${targetWord}"`);

  await ensureDeckExists(deckName);

  // Bank words can carry trailing punctuation ("haar.") which would make the
  // word-boundary pattern unmatchable — match and display the clean form
  // (#68, #108).
  const [cleanTarget] = splitTrailingPunctuation(targetWord);

  // Highlight the target word in the sentence. Unicode-aware boundaries
  // (#289): \b is ASCII-only, so it saw a boundary inside "Häuser" at the ä
  // and happily highlighted embedded fragments; the lookarounds treat any
  // letter/digit neighbor as word-internal, in every script. Unspaced CJK
  // takes the token-span path instead (#289 4.7).
  const highlightedSentence = wrapWholeWord(
    sentence,
    cleanTarget,
    (match) => `<b>${match}</b>`,
    pack,
  );

  const noteId = await ankiRequest<number | null>('addNote', {
    note: {
      deckName,
      modelName: 'Basic',
      fields: {
        Front: `${bdi(highlightedSentence)}<br><br><small>Word: ${bdi(`<b>${cleanTarget}</b>`)}</small>`,
        Back: `${translation}<br><br>${bdi(`<b>${cleanTarget}</b>`)} = ${wordMeaning}`,
      },
      options: {
        allowDuplicate: true, // Allow duplicates - same word from different sentences is fine
      },
      tags: ['lector', 'vocabulary'],
    },
  });

  // AnkiConnect returns null if the note couldn't be added
  if (noteId === null) {
    throw new Error(
      "Failed to add note - check that 'Basic' note type exists with 'Front' and 'Back' fields",
    );
  }

  console.log(`[Anki] Successfully added basic note with ID: ${noteId}`);
  return noteId;
}

/**
 * Add a pure word flashcard to Anki (issue #197).
 * Front: the word only (bold, so syncWordStates can round-trip it).
 * Back: translation + word = meaning line.
 */
export async function addWordCard(
  deckName: string,
  targetWord: string,
  translation: string,
  wordMeaning: string,
  sourceHtml?: string,
): Promise<number> {
  await ensureDeckExists(deckName);
  const [cleanTarget] = splitTrailingPunctuation(targetWord);
  const sourceLine = sourceHtml ? `<br><br><small>${sourceHtml}</small>` : '';

  const noteId = await ankiRequest<number | null>('addNote', {
    note: {
      deckName,
      modelName: 'Basic',
      fields: {
        // No <bdi> on this one. The field holds the word and nothing else, so
        // there is no neighbouring run for the bidi algorithm to resolve it
        // against — a lone Arabic word takes its own direction — and
        // `cleanTarget` has already had its punctuation split off. #197 pins
        // this field to exactly `<b>word</b>`, which is what the round-trip
        // reader matches on.
        Front: `<b>${cleanTarget}</b>`,
        Back: `${translation}<br><br>${bdi(`<b>${cleanTarget}</b>`)} = ${wordMeaning}${sourceLine}`,
      },
      options: { allowDuplicate: true },
      tags: ['lector', 'vocabulary'],
    },
  });

  if (noteId === null) {
    throw new Error(
      "Failed to add note — check that 'Basic' note type exists with 'Front' and 'Back' fields",
    );
  }

  return noteId;
}

/**
 * Build the cloze-deletion text for a sentence. Strips trailing punctuation
 * from the target first — bank words can carry it ("haar."), which would make
 * the word-boundary pattern unmatchable and produce a cloze-less note that
 * AnkiConnect rejects (#68, #108). Punctuation stays outside the blank.
 * Unicode-aware boundaries (#289): ASCII \b mismatched every non-Latin script
 * and false-matched inside diacritic words. Exported for tests.
 */
export function buildClozeText(
  sentence: string,
  targetWord: string,
  pack?: LanguageConfig,
): string {
  const [cleanTarget] = splitTrailingPunctuation(targetWord);
  // `pack` routes unspaced CJK to token-span matching (#289 4.7). Without it
  // the lookaround matcher never fires on Chinese and addClozeCard throws.
  return wrapWholeWord(sentence, cleanTarget, (match) => `{{c1::${match}}}`, pack);
}

/**
 * Add a cloze deletion card to Anki
 * @param deckName - Name of the deck to add the card to
 * @param sentence - The Afrikaans sentence containing the target word
 * @param targetWord - The word being learned (will be hidden in cloze)
 * @param translation - English translation of the sentence
 * @param wordMeaning - English meaning of the target word
 * @returns The note ID of the created card
 */
export async function addClozeCard(
  deckName: string,
  sentence: string,
  targetWord: string,
  translation: string,
  wordMeaning: string,
  sourceHtml?: string,
  pack?: LanguageConfig,
): Promise<number> {
  console.log(`[Anki] Adding cloze card to deck "${deckName}" for word "${targetWord}"`);

  await ensureDeckExists(deckName);

  const [cleanTarget] = splitTrailingPunctuation(targetWord);
  const clozeText = buildClozeText(sentence, targetWord, pack);
  const sourceLine = sourceHtml ? `<br><br><small>${sourceHtml}</small>` : '';

  // A note without a {{c1::…}} blank is invalid — fail with a clear message
  // instead of letting AnkiConnect reject it opaquely.
  if (!clozeText.includes('{{c1::')) {
    throw new Error(`Could not build cloze: "${cleanTarget}" not found in sentence`);
  }

  console.log(`[Anki] Cloze text: ${clozeText}`);

  const noteId = await ankiRequest<number | null>('addNote', {
    note: {
      deckName,
      modelName: 'Cloze',
      fields: {
        Text: `${bdi(clozeText)}<br><br><small>Translation: ${translation}</small>`,
        Extra: `${bdi(`<b>${cleanTarget}</b>`)} = ${wordMeaning}${sourceLine}`,
      },
      options: {
        allowDuplicate: true, // Allow duplicates - user may want the same word from different sentences
      },
      tags: ['lector', 'vocabulary', 'cloze'],
    },
  });

  // AnkiConnect returns null if the note couldn't be added
  if (noteId === null) {
    throw new Error(
      "Failed to add note - check that 'Cloze' note type exists with 'Text' and 'Extra' fields",
    );
  }

  console.log(`[Anki] Successfully added note with ID: ${noteId}`);
  return noteId;
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Add a note in a user-defined format (see anki-formats.ts). Audio fields get
 * server TTS of `audioText`; `audioFailed` reports that no voice was available
 * and the note was added without it.
 */
/**
 * Tag for cards with no target word. Not `lector`, so syncWordStates never
 * reads the sentence as a vocab word.
 */
export const SENTENCE_CARD_TAG = 'lector-sentence';

/** Base64 audio cut from the lesson's own media, used in place of TTS. */
export interface AnkiAudioClip {
  data: string;
  filename: string;
}

/** Store the note's audio in Anki's media folder and return its [sound:] tag, or null without a voice. */
async function storeNoteAudio(
  text: string,
  language: string,
  clip?: AnkiAudioClip,
): Promise<string | null> {
  if (clip) {
    const stored = await ankiRequest<string>('storeMediaFile', { ...clip });
    return `[sound:${stored}]`;
  }
  const audio = await synthesizeSpeech(text, language);
  if (!audio) return null;
  const ext = audio.contentType.includes('wav') ? 'wav' : 'mp3';
  const stored = await ankiRequest<string>('storeMediaFile', {
    filename: `lector-${language}-${hashText(text)}.${ext}`,
    data: audio.audioContent,
  });
  return `[sound:${stored}]`;
}

export async function addFormattedNote(
  deckName: string,
  format: AnkiNoteFormat,
  content: AnkiCardContent,
  options: {
    /** Pronunciation: `clip` when given, else TTS of this text. */
    audioText: string;
    clip?: AnkiAudioClip;
    /** Sentence audio: this clip when given, else TTS of the card's sentence. */
    sentenceClip?: AnkiAudioClip;
    language: string;
    pack?: LanguageConfig;
    /** Replaces the `lector` tags. A card without `lector` stays out of syncWordStates. */
    tags?: string[];
  },
): Promise<{ noteId: number; audioFailed: boolean }> {
  await ensureDeckExists(deckName);
  const fields = renderNoteFields(format, content, options.pack);

  let audioFailed = false;
  const stored = new Map<string, Promise<string | null>>();
  const fillAudio = async (source: AnkiFieldSource, text: string, clip?: AnkiAudioClip) => {
    const names = fieldsWithSource(format, source);
    if (names.length === 0 || (!clip && !text)) return;
    const key = clip ? `clip:${clip.filename}` : `tts:${text}`;
    if (!stored.has(key)) stored.set(key, storeNoteAudio(text, options.language, clip));
    const sound = await stored.get(key);
    if (!sound) audioFailed = true;
    else for (const name of names) fields[name] = sound;
  };
  await fillAudio('audio', options.audioText.trim(), options.clip);
  await fillAudio('sentenceAudio', content.sentence.trim(), options.sentenceClip);

  const noteId = await ankiRequest<number | null>('addNote', {
    note: {
      deckName,
      modelName: format.modelName,
      fields,
      options: { allowDuplicate: true },
      tags: options.tags ?? ['lector', 'vocabulary', ...(isClozeFormat(format) ? ['cloze'] : [])],
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && /note because it is empty/i.test(error.message)) {
      throw new Error(
        `Anki rejected the note: the first field of '${format.modelName}' is empty. In Settings → Anki Integration → Card formats, map it to a value that is always filled, such as Sentence.`,
      );
    }
    throw error;
  });
  if (noteId === null) {
    throw new Error(`Failed to add note — check that the '${format.modelName}' note type exists`);
  }
  return { noteId, audioFailed };
}

/**
 * Add a sentence as a Basic card with no target word: the sentence and its
 * audio on the front, the translation on the back.
 */
export async function addSentenceCard(
  deckName: string,
  sentence: string,
  translation: string,
  detailsHtml: string,
  options: { language: string; clip?: AnkiAudioClip },
): Promise<{ noteId: number; audioFailed: boolean }> {
  await ensureDeckExists(deckName);
  const sound = await storeNoteAudio(sentence.trim(), options.language, options.clip);
  const details = detailsHtml ? `<br><br><small>${detailsHtml}</small>` : '';
  const noteId = await ankiRequest<number | null>('addNote', {
    note: {
      deckName,
      modelName: 'Basic',
      fields: {
        Front: `${bdi(sentence)}${sound ? `<br>${sound}` : ''}`,
        Back: `${translation}${details}`,
      },
      options: { allowDuplicate: true },
      tags: [SENTENCE_CARD_TAG],
    },
  });
  if (noteId === null) {
    throw new Error(
      "Failed to add note — check that 'Basic' note type exists with 'Front' and 'Back' fields",
    );
  }
  return { noteId, audioFailed: sound === null };
}

/**
 * Isolate a run of target-language text inside a card field (#253).
 *
 * An Anki card puts target-language text and English on one line, separated by
 * neutral characters (`Word: `, ` = `). The bidi algorithm resolves a neutral
 * against the surrounding paragraph, so an Arabic word after "Word: " drags the
 * colon to the wrong side, and a sentence-final full stop renders at the card's
 * left edge instead of at the end of the sentence.
 *
 * `<bdi>` fixes both and needs no per-language branching: it isolates the run,
 * and its default `dir="auto"` reads the direction off the run's own first
 * strong character. Left-to-right packs are unaffected.
 *
 * WRAP THE EMPHASIS, never the text inside it. `syncWordStates` reads the word
 * back out of a card with `/<b>([^<]+)<\/b>/`, and that class stops at the
 * first `<`. So `<b><bdi>word</bdi></b>` makes the probe return null and a
 * lector card stops reporting its review state. `<bdi><b>word</b></bdi>` keeps
 * the probe intact, and `stripHtml` drops the extra tag like any other.
 */
function bdi(text: string): string {
  return `<bdi>${text}</bdi>`;
}

/** Strip HTML tags and trim whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the sentence context from card fields (best-effort).
 * Basic Front: "{sentence}<br><br><small>Word: <b>word</b></small>"
 * Cloze Text:  "{sentence{{c1::word}}}<br><br><small>Translation: ...</small>"
 */
function extractSentence(frontField: string, textField: string): string {
  const raw = frontField || textField;
  if (!raw) return '';
  const beforeBreak = raw.split(/<br\s*\/?><br\s*\/?>/i)[0] ?? '';
  return stripHtml(beforeBreak.replace(/\{\{c\d+::([^}]+)\}\}/g, '$1'));
}

/**
 * Extract the translation from card fields (best-effort).
 * Basic Back:  "{translation}<br><br><b>word</b> = meaning"
 * Cloze Text:  "...<small>Translation: {translation}</small>"
 * Cloze Extra: "<b>word</b> = meaning"
 */
function extractTranslation(backField: string, textField: string, extraField: string): string {
  // Cloze: translation embedded in Text field
  const clozeMatch = textField.match(/Translation:\s*([^<]+)/i);
  if (clozeMatch) return clozeMatch[1].trim();

  // Basic: first segment of Back field
  if (backField) {
    const beforeBreak = backField.split(/<br\s*\/?><br\s*\/?>/i)[0] ?? '';
    const text = stripHtml(beforeBreak);
    if (text) return text;
  }

  // Extra field fallback: "<b>word</b> = meaning"
  if (extraField) {
    const eqMatch = extraField.match(/=\s*(.+)$/);
    if (eqMatch) return stripHtml(eqMatch[1]);
  }

  return '';
}

interface CustomFieldNames {
  word?: string;
  sentence?: string;
  definition?: string;
}

/** Note type → the fields a user format writes the word, sentence and definition into. */
export function customFieldNamesByModel(formats: AnkiNoteFormats): Map<string, CustomFieldNames> {
  const byModel = new Map<string, CustomFieldNames>();
  for (const perLanguage of Object.values(formats)) {
    for (const format of Object.values(perLanguage ?? {})) {
      if (!format?.modelName) continue;
      const names = byModel.get(format.modelName) ?? {};
      for (const [field, source] of Object.entries(format.fields)) {
        if (source === 'word') names.word ??= field;
        if (source === 'sentence' || source === 'sentenceCloze') names.sentence ??= field;
        if (source === 'definition') names.definition ??= field;
      }
      byModel.set(format.modelName, names);
    }
  }
  return byModel;
}

/**
 * Query AnkiConnect for all lector-created cards (tagged `lector` or
 * `afrikaans-reader`) and return a map of
 * word → { type, interval, sentence, translation, deckName }.
 * When a word has multiple cards the one that maps to the highest lector
 * state is kept.
 *
 * The sync is scoped to lector's own tags on purpose — every card lector
 * exports is tagged, so this catches all of them. It deliberately does NOT
 * scan whole decks: that sweeps in the user's hand-made cards (custom note
 * types, English-fronted Basic cards) that lector can't reliably read a word
 * from, producing junk imports.
 */
export async function syncWordStates(): Promise<
  Map<
    string,
    { interval: number; type: number; sentence: string; translation: string; deckName: string }
  >
> {
  const query = '(tag:lector OR tag:afrikaans-reader)';
  console.log(`Anki sync query: ${query}`);
  const cardIds = await ankiRequest<number[]>('findCards', { query });
  console.log(`Found ${cardIds.length} cards in Anki`);

  if (cardIds.length === 0) {
    return new Map();
  }

  // Get card info
  const cardsInfo = await ankiRequest<CardInfo[]>('cardsInfo', {
    cards: cardIds,
  });
  const customFields = customFieldNamesByModel(await loadAnkiNoteFormats());

  // Build a map of word -> { type, interval, sentence, translation, deckName }
  const wordStates = new Map<
    string,
    { interval: number; type: number; sentence: string; translation: string; deckName: string }
  >();

  const recordCard = (rawWord: string, card: CardInfo, sentence: string, translation: string) => {
    // Anki card text is an external ingress (#289): fold like every other
    // vocab key so decomposed input still matches lector entries.
    const word = foldWord(rawWord.trim(), getActivePack());
    const cardState = ankiCardToState(card.type, card.interval);
    // Skip New cards — they carry no learning signal and must not occupy a
    // word slot, so a word whose only cards are New stays out of the sync.
    if (!cardState) return;
    // Keep the card that maps to the highest lector state (dedup by rank).
    const existing = wordStates.get(word);
    const existingState = existing ? ankiCardToState(existing.type, existing.interval) : null;
    const existingRank = existingState ? STATE_RANK[existingState] : -1;
    if (STATE_RANK[cardState] > existingRank) {
      wordStates.set(word, {
        interval: card.interval,
        type: card.type,
        sentence,
        translation,
        deckName: card.deckName,
      });
    }
  };

  for (const card of cardsInfo) {
    const custom = customFields.get(card.modelName);
    if (custom) {
      const customWord = custom.word ? stripHtml(card.fields[custom.word]?.value || '') : '';
      if (customWord) {
        const sentence = custom.sentence ? card.fields[custom.sentence]?.value || '' : '';
        const definition = custom.definition ? card.fields[custom.definition]?.value || '' : '';
        recordCard(
          customWord,
          card,
          stripHtml(sentence.replace(/\{\{c\d+::([^}]+)\}\}/g, '$1')),
          stripHtml(definition),
        );
      }
      continue;
    }

    // Extract the target word. Try in order:
    // 1. Bold text (our format): <b>word</b>
    // 2. Dedicated Word field
    // 3. Plain Front field (simple vocab cards, ≤ 50 chars, no full stop)
    // 4. Cloze text: {{c1::word}} pattern

    let word: string | null = null;

    const frontField = card.fields['Front']?.value || '';
    const textField = card.fields['Text']?.value || '';
    const backField = card.fields['Back']?.value || '';
    const extraField = card.fields['Extra']?.value || '';
    const wordField = card.fields['Word']?.value || '';

    const boldMatch = (frontField || textField).match(/<b>([^<]+)<\/b>/);
    if (boldMatch) {
      word = boldMatch[1];
    } else if (wordField) {
      word = wordField.replace(/<[^>]*>/g, '').trim();
    } else if (frontField) {
      const plainText = frontField.replace(/<[^>]*>/g, '').trim();
      if (plainText.length < 50 && !plainText.includes('.')) {
        word = plainText.split(/\s+/)[0];
      }
    } else if (textField) {
      const clozeMatch = textField.match(/\{\{c\d+::([^}]+)\}\}/);
      if (clozeMatch) {
        word = clozeMatch[1];
      }
    }

    if (word) {
      recordCard(
        word,
        card,
        extractSentence(frontField, textField),
        extractTranslation(backField, textField, extraField),
      );
    }
  }

  console.log(
    `Extracted ${wordStates.size} unique words from Anki cards:`,
    Array.from(wordStates.keys()).slice(0, 10).join(', ') + (wordStates.size > 10 ? '...' : ''),
  );
  return wordStates;
}

/** mm:ss / h:mm:ss label for a millisecond offset (#334). Mirrors
 *  formatClipTimestamp in api/src/lib/anki.ts. */
export function formatClipTimestamp(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render the Anki "Source" line for a card mined from a video transcript
 * (#334): a link to the source video at the segment start, labelled with the
 * segment's start–end. Mirrors buildSourceLinkHtml in api/src/lib/anki.ts (the
 * selfhost browser→AnkiConnect path builds the card HTML client-side). Returns
 * '' when there is no usable source URL.
 */
export function buildSourceLinkHtml(source: {
  sourceUrl?: string | null;
  startMs?: number | null;
  endMs?: number | null;
}): string {
  const raw = typeof source.sourceUrl === 'string' ? source.sourceUrl.trim() : '';
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const start = typeof source.startMs === 'number' && source.startMs >= 0 ? source.startMs : null;
  const end = typeof source.endMs === 'number' && source.endMs >= 0 ? source.endMs : null;
  if (start !== null) url.searchParams.set('t', `${Math.floor(start / 1000)}s`);
  const range =
    start !== null && end !== null
      ? `${formatClipTimestamp(start)}–${formatClipTimestamp(end)}`
      : start !== null
        ? formatClipTimestamp(start)
        : 'Source';
  return `<a href="${escapeHtmlAttr(url.toString())}">▶ ${range}</a>`;
}
