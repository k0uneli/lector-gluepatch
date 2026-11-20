// Declension and conjugation tables built from the kaikki `inflections` rows
// that languages/inflection.ts also reads.

import { formatInflectionTags, isInflectionType, parseTags, type InflectionRow } from './inflection';
import { lowerForPack, stripMarks } from './text';
import type { LanguageConfig } from './types';

export const CASES = [
  'nominative',
  'genitive',
  'dative',
  'accusative',
  'instrumental',
  'prepositional',
  'locative',
  'vocative',
] as const;
export const NUMBERS = ['singular', 'plural'] as const;
export const PERSONS = ['first-person', 'second-person', 'third-person'] as const;
const GENDERS = ['masculine', 'feminine', 'neuter'] as const;
const SHORT_FORM = 'short-form';
/** Tags that name a verb table. Others (indicative, rare, informal…) do not split one. */
const VERB_GROUP_TAGS = new Set([
  'present',
  'future',
  'past',
  'imperfect',
  'perfect',
  'dependent',
  'imperative',
  'active',
  'passive',
  'perfective',
  'imperfective',
  'participle',
  'adverbial',
]);
/** Forms that belong beside a declension, not in it. */
const DEGREE_TAGS = new Set(['comparative', 'superlative']);
const NONSTANDARD_TAGS = new Set([
  'misspelling',
  'nonstandard',
  'proscribed',
  'dialectal',
  'Katharevousa',
  'polytonic',
  'pronunciation-spelling',
  'error-unknown-tag',
  'unaccented',
]);
const TENSE_ORDER = ['present', 'future', 'imperfect', 'past', 'dependent', 'imperative'];
const AGREEING_POS = new Set(['adj', 'det', 'pron', 'num', 'participle']);
const WORD_FORM = /^\p{L}[\p{L}\p{M}'’ -]*$/u;

export type ParadigmKind = 'noun' | 'adjective' | 'verb';

export interface ParadigmCell {
  /** The tags that name this cell, e.g. ["genitive", "plural"]. */
  tags: string[];
  /** Empty when the dictionary lists no form for the cell. */
  forms: string[];
}

export interface ParadigmTable {
  /** "" for the single table of a noun or adjective. */
  title: string;
  columns: string[];
  rows: Array<{ label: string; cells: ParadigmCell[] }>;
}

export interface Paradigm {
  lemma: string;
  kind: ParadigmKind;
  /** The headword's parts of speech in the dictionary, e.g. ["noun"]. */
  partsOfSpeech: string[];
  tables: ParadigmTable[];
  /** Forms outside the grids: participles, gerunds. */
  other: Array<{ label: string; forms: string[] }>;
}

interface TaggedForm {
  form: string;
  tags: string[];
}

const pick = <T extends string>(tags: readonly string[], set: readonly T[]): T[] =>
  set.filter((t) => tags.includes(t));

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Adds `form` unless the cell already holds it, or holds it with its accents. */
function addForm(forms: string[], form: string, pack: LanguageConfig): void {
  const key = stripMarks(lowerForPack(form, pack));
  const i = forms.findIndex((f) => stripMarks(lowerForPack(f, pack)) === key);
  if (i === -1) forms.push(form);
  else if (form.normalize('NFD').length > forms[i].normalize('NFD').length) forms[i] = form;
}

class Grid {
  private readonly cells = new Map<string, string[]>();

  add(key: string, form: string, pack: LanguageConfig): void {
    const forms = this.cells.get(key) ?? [];
    addForm(forms, form, pack);
    this.cells.set(key, forms);
  }

  get(key: string): string[] {
    return this.cells.get(key) ?? [];
  }

  has(key: string): boolean {
    return this.get(key).length > 0;
  }
}

function usableRows(
  rows: readonly InflectionRow[],
  lemmaPos: readonly string[],
  pack: LanguageConfig,
): TaggedForm[] {
  const bare = pack.inflection?.bareTagCells ?? {};
  return rows.flatMap(({ form, type }) => {
    if (!isInflectionType(type, lemmaPos) || !WORD_FORM.test(form)) return [];
    const tags = parseTags(type);
    if (tags.some((t) => NONSTANDARD_TAGS.has(t))) return [];
    const cell = tags.length === 1 ? bare[tags[0]] : undefined;
    return [{ form, tags: cell ? [...cell] : tags }];
  });
}

function classify(rows: readonly TaggedForm[], lemmaPos: readonly string[]): ParadigmKind | null {
  if (rows.some((r) => pick(r.tags, PERSONS).length > 0)) return 'verb';
  const nominal = rows.some(
    (r) => pick(r.tags, CASES).length > 0 || pick(r.tags, NUMBERS).length > 0,
  );
  if (!nominal) return null;
  const agreeing =
    lemmaPos.some((pos) => AGREEING_POS.has(pos)) &&
    rows.some((r) => pick(r.tags, GENDERS).length > 0);
  return agreeing ? 'adjective' : 'noun';
}

const isDegree = (tags: readonly string[]) => tags.some((t) => DEGREE_TAGS.has(t));

function degreeForms(rows: readonly TaggedForm[], pack: LanguageConfig): Paradigm['other'] {
  const byLabel = new Map<string, string[]>();
  for (const { form, tags } of rows.filter((r) => isDegree(r.tags))) {
    const label = formatInflectionTags(tags);
    const forms = byLabel.get(label) ?? [];
    addForm(forms, form, pack);
    byLabel.set(label, forms);
  }
  return [...byLabel.entries()].map(([label, forms]) => ({ label, forms }));
}

function nounTable(lemma: string, rows: readonly TaggedForm[], pack: LanguageConfig): ParadigmTable {
  const grid = new Grid();
  for (const { form, tags } of rows.filter((r) => !isDegree(r.tags))) {
    const numbers = pick(tags, NUMBERS);
    let cases: string[] = pick(tags, CASES);
    if (cases.length === 0 && numbers.includes('plural')) cases = ['nominative'];
    for (const c of cases) {
      for (const n of numbers.length > 0 ? numbers : ['singular']) grid.add(`${c}|${n}`, form, pack);
    }
  }
  if (!grid.has('nominative|singular')) grid.add('nominative|singular', lemma, pack);

  const numbers = NUMBERS.filter((n) => CASES.some((c) => grid.has(`${c}|${n}`)));
  return {
    title: '',
    columns: [...numbers],
    rows: CASES.filter((c) => numbers.some((n) => grid.has(`${c}|${n}`))).map((c) => ({
      label: c,
      cells: numbers.map((n) => ({ tags: [c, n], forms: grid.get(`${c}|${n}`) })),
    })),
  };
}

function adjectiveTable(
  lemma: string,
  rows: readonly TaggedForm[],
  pack: LanguageConfig,
): ParadigmTable {
  const grid = new Grid();
  for (const { form, tags } of rows.filter((r) => !isDegree(r.tags))) {
    const short = tags.includes(SHORT_FORM);
    let cases: string[] = short ? [SHORT_FORM] : pick(tags, CASES);
    if (cases.length === 0) cases = ['nominative'];
    const genders = pick(tags, GENDERS);
    const number = tags.includes('plural') ? 'plural' : 'singular';
    const columns =
      genders.length > 0 ? genders.map((g) => `${g}.${number}`) : [`masculine.${number}`];
    const cols = number === 'plural' && genders.length === 0 ? ['plural'] : columns;
    for (const c of cases) for (const col of cols) grid.add(`${c}|${col}`, form, pack);
  }
  if (!grid.has('nominative|masculine.singular')) {
    grid.add('nominative|masculine.singular', lemma, pack);
  }

  const rowKeys = [...CASES, SHORT_FORM];
  const allColumns = [
    ...GENDERS.map((g) => `${g}.singular`),
    ...GENDERS.map((g) => `${g}.plural`),
    'plural',
  ];
  const columns = allColumns.filter((col) => rowKeys.some((r) => grid.has(`${r}|${col}`)));
  const gendersInPlural = columns.some((col) => col !== 'plural' && col.endsWith('.plural'));
  const label = (col: string) => {
    if (col === 'plural') return 'plural';
    const [gender, number] = col.split('.');
    return gendersInPlural ? `${gender} ${number}` : gender;
  };
  return {
    title: '',
    columns: columns.map(label),
    rows: rowKeys
      .filter((r) => columns.some((col) => grid.has(`${r}|${col}`)))
      .map((r) => ({
        label: r === SHORT_FORM ? 'short form' : r,
        cells: columns.map((col) => ({
          tags: [r, ...col.split('.')],
          forms: grid.get(`${r}|${col}`),
        })),
      })),
  };
}

function tenseRank(tags: readonly string[]): number {
  const i = TENSE_ORDER.findIndex((t) => tags.includes(t));
  return (i === -1 ? TENSE_ORDER.length : i) * 2 + (tags.includes('passive') ? 1 : 0);
}

function verbTables(
  lemma: string,
  rows: readonly TaggedForm[],
  pack: LanguageConfig,
): Pick<Paradigm, 'tables' | 'other'> {
  interface Group {
    tags: string[];
    byGender: boolean;
    grid: Grid;
  }
  const groups = new Map<string, Group>();
  const group = (tags: string[], byGender: boolean): Group => {
    const key = `${byGender ? 'g' : 'p'}:${tags.join(',')}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { tags, byGender, grid: new Grid() }));
    return g;
  };
  const otherForms = new Map<string, string[]>();
  const lemmaTags = pack.inflection?.verbLemmaTags;
  const allRows = lemmaTags ? [...rows, { form: lemma, tags: [...lemmaTags] }] : rows;

  for (const { form, tags } of allRows) {
    const persons = pick(tags, PERSONS);
    const genders = pick(tags, GENDERS);
    const numbers = pick(tags, NUMBERS);
    const rest = tags.filter((t) => VERB_GROUP_TAGS.has(t)).sort();
    if (persons.length > 0) {
      const g = group(rest, false);
      for (const p of persons) {
        for (const n of numbers.length > 0 ? numbers : ['singular']) g.grid.add(`${p}|${n}`, form, pack);
      }
    } else if (genders.length > 0 && !rest.includes('participle')) {
      const g = group(rest, true);
      const slots = numbers.includes('plural') ? ['plural'] : genders;
      for (const s of slots) g.grid.add(s, form, pack);
    } else {
      const label = formatInflectionTags(rest);
      const forms = otherForms.get(label) ?? [];
      addForm(forms, form, pack);
      otherForms.set(label, forms);
    }
  }

  const ordered = [...groups.values()].sort((a, b) => tenseRank(a.tags) - tenseRank(b.tags));
  const tables = ordered.flatMap((g): ParadigmTable[] => {
    const title = capitalize(formatInflectionTags(g.tags));
    if (g.byGender) {
      const slots = [...GENDERS, 'plural'].filter((s) => g.grid.has(s));
      if (slots.length === 0) return [];
      return [
        {
          title,
          columns: [''],
          rows: slots.map((s) => ({
            label: s,
            cells: [
              {
                tags: [...g.tags, ...(s === 'plural' ? ['plural'] : [s, 'singular'])],
                forms: g.grid.get(s),
              },
            ],
          })),
        },
      ];
    }
    const numbers = NUMBERS.filter((n) => PERSONS.some((p) => g.grid.has(`${p}|${n}`)));
    const persons = PERSONS.filter((p) => numbers.some((n) => g.grid.has(`${p}|${n}`)));
    if (persons.length === 0) return [];
    return [
      {
        title,
        columns: [...numbers],
        rows: persons.map((p) => ({
          label: p.replace('-person', ' person').replace(/^(first|second|third)/, (m) =>
            m === 'first' ? '1st' : m === 'second' ? '2nd' : '3rd',
          ),
          cells: numbers.map((n) => ({ tags: [...g.tags, p, n], forms: g.grid.get(`${p}|${n}`) })),
        })),
      },
    ];
  });

  const inTables = new Set(
    tables.flatMap((t) =>
      t.rows.flatMap((r) => r.cells.flatMap((c) => c.forms.map((f) => stripMarks(lowerForPack(f, pack))))),
    ),
  );
  const other = [...otherForms.entries()]
    .map(([label, forms]) => ({
      label,
      forms: forms.filter((f) => !inTables.has(stripMarks(lowerForPack(f, pack)))),
    }))
    .filter((o) => o.label && o.forms.length > 0);
  return { tables, other };
}

/** Null when the rows do not form a declension or conjugation. */
export function buildParadigm(
  lemma: string,
  lemmaPos: readonly string[],
  rows: readonly InflectionRow[],
  pack: LanguageConfig,
): Paradigm | null {
  const usable = usableRows(rows, lemmaPos, pack);
  const kind = classify(usable, lemmaPos);
  if (!kind) return null;
  if (kind === 'verb') {
    const { tables, other } = verbTables(lemma, usable, pack);
    return tables.length > 0 ? { lemma, kind, partsOfSpeech: [...lemmaPos], tables, other } : null;
  }
  const table =
    kind === 'noun' ? nounTable(lemma, usable, pack) : adjectiveTable(lemma, usable, pack);
  const cells = table.rows.flatMap((r) => r.cells).filter((c) => c.forms.length > 0);
  return cells.length > 1
    ? { lemma, kind, partsOfSpeech: [...lemmaPos], tables: [table], other: degreeForms(usable, pack) }
    : null;
}
