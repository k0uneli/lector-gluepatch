import { getModelFieldNames, getModelNames } from '@/lib/anki';
import {
  ANKI_NOTE_FORMATS_SETTING,
  FIELD_SOURCE_OPTIONS,
  guessFieldMapping,
  isClozeFormat,
  loadAnkiNoteFormats,
  type AnkiCardKind,
  type AnkiFieldSource,
  type AnkiNoteFormat,
  type AnkiNoteFormats,
} from '@/lib/anki-formats';
import { setSetting } from '@/lib/data-layer';
import { LANGUAGES } from '@/lib/languages';
import type { LanguageCode } from '@/types/language';
import { useActiveLanguage, useEnabledLanguages } from '@/utils/hooks';
import { useEffect, useMemo, useState } from 'react';

const SELECT_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none';

const CARD_KINDS: ReadonlyArray<{ value: AnkiCardKind; label: string; hint: string }> = [
  {
    value: 'word',
    label: 'Word card',
    hint: 'Used for a single word added from the reader, and for Basic exports from Vocabulary.',
  },
  {
    value: 'sentence',
    label: 'Sentence card',
    hint: 'Used for a selected phrase or sentence in the reader, for cards added in cloze practice, and for Cloze exports from Vocabulary.',
  },
];

const SOURCE_HELP: ReadonlyArray<[string, string]> = [
  ['Word', 'the word you added; on a sentence card with no word picked, the sentence'],
  ['Sentence', 'the sentence, with the word in bold'],
  ['Sentence (cloze)', 'the sentence, with the word blanked as {{c1::…}}'],
  ['Definition', 'the short meaning; an AI result replaces the on-device dictionary'],
  ['Definition #2', 'the full AI entry or phrase breakdown, when there is one'],
  ['Pronunciation', 'audio of the word on a word card, or of the sentence on a sentence card'],
  [
    'Sentence audio',
    'audio of the whole sentence: the line cut from an audio or video lesson, otherwise server audio',
  ],
];

export default function AnkiCardFormats({ connected }: { connected: boolean }) {
  const activeLang = useActiveLanguage();
  const enabledLanguages = useEnabledLanguages();
  const languages = useMemo<LanguageCode[]>(
    () =>
      enabledLanguages.includes(activeLang.code)
        ? enabledLanguages
        : [activeLang.code, ...enabledLanguages],
    [enabledLanguages, activeLang.code],
  );

  const [pickedLanguage, setPickedLanguage] = useState<LanguageCode | null>(null);
  const language = pickedLanguage ?? activeLang.code;
  const [kind, setKind] = useState<AnkiCardKind>('word');
  const [formats, setFormats] = useState<AnkiNoteFormats>({});
  const [modelNames, setModelNames] = useState<string[]>([]);
  const [fieldsByModel, setFieldsByModel] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  const format = formats[language]?.[kind];
  const modelName = format?.modelName ?? '';

  useEffect(() => {
    void loadAnkiNoteFormats().then(setFormats);
  }, []);

  useEffect(() => {
    if (!connected) return;
    getModelNames()
      .then((names) => setModelNames([...names].sort((a, b) => a.localeCompare(b))))
      .catch(() => setModelNames([]));
  }, [connected]);

  useEffect(() => {
    if (!connected || !modelName || fieldsByModel[modelName]) return;
    let cancelled = false;
    getModelFieldNames(modelName)
      .then((names) => {
        if (!cancelled) setFieldsByModel((prev) => ({ ...prev, [modelName]: names }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connected, modelName, fieldsByModel]);

  const save = (next: AnkiNoteFormats) => {
    const previous = formats;
    setFormats(next);
    setError(null);
    void setSetting(ANKI_NOTE_FORMATS_SETTING, next).catch((err) => {
      setFormats(previous);
      setError(err instanceof Error ? err.message : 'Failed to save the card format');
    });
  };

  const updateFormat = (nextFormat: AnkiNoteFormat | null) => {
    const perLanguage = { ...formats[language] };
    if (nextFormat) perLanguage[kind] = nextFormat;
    else delete perLanguage[kind];
    const next = { ...formats };
    if (Object.keys(perLanguage).length > 0) next[language] = perLanguage;
    else delete next[language];
    save(next);
  };

  const chooseModel = async (name: string) => {
    if (!name) {
      updateFormat(null);
      return;
    }
    try {
      const names = fieldsByModel[name] ?? (await getModelFieldNames(name));
      setFieldsByModel((prev) => ({ ...prev, [name]: names }));
      updateFormat({ modelName: name, fields: guessFieldMapping(names, kind) });
    } catch {
      setError(`Could not read the fields of "${name}" from Anki.`);
    }
  };

  const setFieldSource = (field: string, source: AnkiFieldSource | '') => {
    if (!format) return;
    const fields = { ...format.fields };
    if (source) fields[field] = source;
    else delete fields[field];
    updateFormat({ ...format, fields });
  };

  const modelOptions =
    modelName && !modelNames.includes(modelName) ? [modelName, ...modelNames] : modelNames;
  const fieldNames = format ? (fieldsByModel[modelName] ?? Object.keys(format.fields)) : [];
  const kindConfig = CARD_KINDS.find((k) => k.value === kind)!;

  return (
    <div className="space-y-4 border-t border-border pt-4" data-testid="anki-card-formats">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Card formats</h3>
        <p className="text-xs text-muted-foreground">
          Use your own note types. For each language and card, pick a note type and choose what
          Lector writes into each of its fields.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-foreground">Language</label>
          <select
            value={language}
            data-testid="anki-format-language"
            onChange={(e) => setPickedLanguage(e.target.value as LanguageCode)}
            className={SELECT_CLASS}
          >
            {languages.map((code) => (
              <option key={code} value={code}>
                {LANGUAGES[code].name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground">Card</label>
          <select
            value={kind}
            data-testid="anki-format-kind"
            onChange={(e) => setKind(e.target.value as AnkiCardKind)}
            className={SELECT_CLASS}
          >
            {CARD_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{kindConfig.hint}</p>

      <div>
        <label className="block text-sm font-medium text-foreground">Note type</label>
        <select
          value={modelName}
          data-testid="anki-format-model"
          onChange={(e) => void chooseModel(e.target.value)}
          disabled={!connected && !modelName}
          className={SELECT_CLASS}
        >
          <option value="">Lector default</option>
          {modelOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {!connected && (
          <p className="mt-1 text-xs text-muted-foreground">
            Connect to Anki to list your note types.
          </p>
        )}
      </div>

      {format && (
        <div className="space-y-2" data-testid="anki-format-fields">
          <div className="grid grid-cols-2 gap-2 text-xs font-medium text-muted-foreground">
            <span>Anki field</span>
            <span>Lector value</span>
          </div>
          {fieldNames.map((field) => (
            <div key={field} className="grid grid-cols-2 items-center gap-2">
              <span className="truncate text-sm text-foreground" title={field}>
                {field}
              </span>
              <select
                value={format.fields[field] ?? ''}
                data-testid={`anki-format-field-${field}`}
                onChange={(e) => setFieldSource(field, e.target.value as AnkiFieldSource | '')}
                className={SELECT_CLASS}
              >
                <option value="">Not used</option>
                {FIELD_SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {Object.keys(format.fields).length === 0 ? (
            <p className="text-xs text-destructive">
              Map at least one field. Until you do, Lector adds its default card.
            </p>
          ) : (
            kind === 'sentence' && (
              <p className="text-xs text-muted-foreground">
                {isClozeFormat(format)
                  ? 'Cloze card: the word you pick is blanked.'
                  : 'Sentence card, not cloze: the word you pick is bold, and picking one is optional. A Cloze note type needs a field set to Sentence (cloze).'}
              </p>
            )
          )}
          <ul className="space-y-0.5 pt-1 text-xs text-muted-foreground">
            {SOURCE_HELP.map(([label, help]) => (
              <li key={label}>
                <span className="font-medium text-foreground">{label}</span> — {help}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-[color-mix(in_srgb,var(--destructive)_12%,var(--card))] p-3 text-sm text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
