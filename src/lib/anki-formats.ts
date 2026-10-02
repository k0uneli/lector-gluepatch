// User-defined Anki note formats for the AnkiConnect transport: per language,
// a word card and a sentence card, each an Anki note type whose fields are
// mapped to Lector values. The addon transport keeps its fixed Lector models.

import { wrapWholeWord, type LanguageConfig } from './languages';
import { splitTrailingPunctuation } from './words';
import { getSetting } from './data-layer';

export const ANKI_NOTE_FORMATS_SETTING = 'ankiNoteFormats';

export type AnkiCardKind = 'word' | 'sentence';

export type AnkiFieldSource =
  | 'word'
  | 'sentence'
  | 'sentenceCloze'
  | 'definition'
  | 'definition2'
  | 'image'
  | 'audio'
  | 'sentenceAudio';

export interface AnkiNoteFormat {
  modelName: string;
  /** Anki field name → the Lector value written into it. Unmapped fields stay empty. */
  fields: Record<string, AnkiFieldSource>;
}

export type AnkiLanguageFormats = Partial<Record<AnkiCardKind, AnkiNoteFormat>>;
export type AnkiNoteFormats = Partial<Record<string, AnkiLanguageFormats>>;

export const FIELD_SOURCE_OPTIONS: ReadonlyArray<{ value: AnkiFieldSource; label: string }> = [
  { value: 'word', label: 'Word' },
  { value: 'sentence', label: 'Sentence' },
  { value: 'sentenceCloze', label: 'Sentence (cloze)' },
  { value: 'definition', label: 'Definition' },
  { value: 'definition2', label: 'Definition #2' },
  { value: 'image', label: 'Image (left empty)' },
  { value: 'audio', label: 'Pronunciation (audio)' },
  { value: 'sentenceAudio', label: 'Sentence audio' },
];

export interface AnkiCardContent {
  /** Target word; may carry trailing punctuation. Empty for a sentence card with no target. */
  word: string;
  sentence: string;
  definition: string;
  /** HTML. */
  definition2: string;
}

const GUESSES: Record<string, AnkiFieldSource> = {
  expression: 'word',
  word: 'word',
  front: 'word',
  vocab: 'word',
  vocabulary: 'word',
  term: 'word',
  target: 'word',
  sentence: 'sentence',
  context: 'sentence',
  text: 'sentenceCloze',
  definition: 'definition',
  meaning: 'definition',
  maindefinition: 'definition',
  back: 'definition',
  definition2: 'definition2',
  glossary: 'definition2',
  extra: 'definition2',
  image: 'image',
  picture: 'image',
  audio: 'audio',
  sound: 'audio',
  pronunciation: 'audio',
};

/** Best-effort default mapping for an Anki field name, so common note types need few edits. */
export function guessFieldSource(
  fieldName: string,
  kind: AnkiCardKind,
): AnkiFieldSource | undefined {
  const key = fieldName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key === 'expressionaudio' || key === 'wordaudio')
    return kind === 'word' ? 'audio' : undefined;
  if (key === 'sentenceaudio') return kind === 'sentence' ? 'audio' : 'sentenceAudio';
  return GUESSES[key];
}

export function guessFieldMapping(
  fieldNames: readonly string[],
  kind: AnkiCardKind,
): Record<string, AnkiFieldSource> {
  const fields: Record<string, AnkiFieldSource> = {};
  for (const name of fieldNames) {
    const source = guessFieldSource(name, kind);
    if (source) fields[name] = source;
  }
  return fields;
}

export async function loadAnkiNoteFormats(): Promise<AnkiNoteFormats> {
  try {
    const stored = await getSetting<AnkiNoteFormats>(ANKI_NOTE_FORMATS_SETTING);
    return stored && typeof stored === 'object' ? stored : {};
  } catch {
    return {};
  }
}

/** The configured format, or null when the language falls back to Lector's built-in cards. */
export function activeNoteFormat(
  formats: AnkiNoteFormats,
  language: string,
  kind: AnkiCardKind,
): AnkiNoteFormat | null {
  const format = formats[language]?.[kind];
  if (!format?.modelName || Object.keys(format.fields).length === 0) return null;
  return format;
}

export function isClozeFormat(format: AnkiNoteFormat): boolean {
  return Object.values(format.fields).includes('sentenceCloze');
}

export function fieldsWithSource(format: AnkiNoteFormat, source: AnkiFieldSource): string[] {
  return Object.keys(format.fields).filter((name) => format.fields[name] === source);
}

/**
 * Render every mapped field except audio, which the caller fills once the
 * media file is stored. Throws when a cloze field cannot place its blank.
 * With no target word, Word holds the sentence: Anki rejects a note whose
 * first field is empty, and mining note types lead with the word field.
 */
export function renderNoteFields(
  format: AnkiNoteFormat,
  content: AnkiCardContent,
  pack?: LanguageConfig,
): Record<string, string> {
  const [cleanWord] = splitTrailingPunctuation(content.word.trim());
  const isolate = (text: string) =>
    pack?.script.direction === 'rtl' && text ? `<bdi>${text}</bdi>` : text;

  const render = (source: AnkiFieldSource): string => {
    switch (source) {
      case 'word':
        return isolate(cleanWord || content.sentence);
      case 'sentence':
        return isolate(
          cleanWord
            ? wrapWholeWord(content.sentence, cleanWord, (m) => `<b>${m}</b>`, pack)
            : content.sentence,
        );
      case 'sentenceCloze': {
        const cloze = cleanWord
          ? wrapWholeWord(content.sentence, cleanWord, (m) => `{{c1::${m}}}`, pack)
          : '';
        if (!cloze.includes('{{c1::')) {
          throw new Error(
            cleanWord
              ? `Could not build cloze: "${cleanWord}" not found in sentence`
              : 'Pick a word to blank — this note type has a cloze field',
          );
        }
        return isolate(cloze);
      }
      case 'definition':
        return content.definition;
      case 'definition2':
        return content.definition2;
      case 'image':
      case 'audio':
      case 'sentenceAudio':
        return '';
    }
  };

  const fields: Record<string, string> = {};
  for (const [name, source] of Object.entries(format.fields)) fields[name] = render(source);
  return fields;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface StructuredEntry {
  senses: Array<{ partOfSpeech: string; gloss: string }>;
  ipa?: string;
  etymology?: string;
  relatedForms?: Array<{ form: string; relation: string }>;
}

/** Definition #2 for a word: the full AI entry as HTML. */
export function formatStructuredEntry(entry: StructuredEntry): string {
  const parts: string[] = [];
  if (entry.ipa) parts.push(escapeHtml(entry.ipa));
  if (entry.senses.length > 0) {
    const items = entry.senses.map((sense) => {
      const pos = sense.partOfSpeech ? `<i>${escapeHtml(sense.partOfSpeech)}</i> ` : '';
      return `<li>${pos}${escapeHtml(sense.gloss)}</li>`;
    });
    parts.push(`<ol>${items.join('')}</ol>`);
  }
  if (entry.etymology) parts.push(`<small>${escapeHtml(entry.etymology)}</small>`);
  if (entry.relatedForms && entry.relatedForms.length > 0) {
    const forms = entry.relatedForms.map(
      (f) => `${escapeHtml(f.form)} (${escapeHtml(f.relation)})`,
    );
    parts.push(`<small>${forms.join(', ')}</small>`);
  }
  return parts.join('<br>');
}

/** Definition #2 for a sentence card: the AI phrase breakdown as HTML. */
export function formatPhraseDetails(
  details: {
    literalBreakdown?: string;
    idiomaticMeaning?: string;
    usageNotes?: string;
    register?: string;
  } | null,
): string {
  if (!details) return '';
  const rows: Array<[string, string | undefined]> = [
    ['Meaning', details.idiomaticMeaning],
    ['Literal', details.literalBreakdown],
    ['Usage', details.usageNotes],
    ['Register', details.register],
  ];
  return rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<b>${label}:</b> ${escapeHtml(value!)}`)
    .join('<br>');
}

/**
 * Word-card definitions from the reader's lookup state. An AI result
 * supersedes the on-device dictionary; Definition #2 holds only AI detail,
 * including AI entries the on-device cache learned earlier (`source: 'cache'`).
 */
export function pickWordDefinitions(lookup: {
  translation: string | null;
  aiContextTranslation: string | null;
  aiStructured: StructuredEntry | null;
  dictEntry: (StructuredEntry & { source?: 'dict' | 'cache' }) | null;
}): { definition: string; definition2: string } {
  const definition =
    lookup.aiContextTranslation ??
    lookup.aiStructured?.senses[0]?.gloss ??
    lookup.dictEntry?.senses[0]?.gloss ??
    lookup.translation ??
    '';
  const aiEntry =
    lookup.aiStructured ?? (lookup.dictEntry?.source === 'cache' ? lookup.dictEntry : null);
  return { definition, definition2: aiEntry ? formatStructuredEntry(aiEntry) : '' };
}
