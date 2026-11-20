import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageConfig } from '@/lib/languages';
import {
  fetchFormsRound,
  FORMS_COUNT_KEY,
  FORMS_KINDS_KEY,
  FORMS_MODE_KEY,
  FormsError,
  getFormsCount,
  getFormsKinds,
  getFormsMode,
  gradeForm,
  gradeSpokenForm,
} from '../forms';

const ru = getLanguageConfig('ru');
const el = getLanguageConfig('el');

describe('gradeForm', () => {
  it('accepts any listed form, ignoring case and punctuation', () => {
    expect(gradeForm('Книгой.', ['книгой', 'книгою'], ru)).toBe('correct');
    expect(gradeForm('книгою', ['книгой', 'книгою'], ru)).toBe('correct');
  });

  it('flags a missing ё as right with a note', () => {
    expect(gradeForm('днем', ['днём'], ru)).toBe('accent');
  });

  it('follows a pack that folds accents in practice', () => {
    expect(gradeForm('γραφεις', ['γράφεις'], el)).toBe('correct');
  });

  it('rejects other forms and empty answers', () => {
    expect(gradeForm('книги', ['книг'], ru)).toBe('wrong');
    expect(gradeForm('  ', ['книг'], ru)).toBe('wrong');
  });
});

describe('gradeSpokenForm', () => {
  it('passes when any heard word is the form', () => {
    expect(gradeSpokenForm('ну книгами', ['книгами'], ru)).toBe(true);
    expect(gradeSpokenForm('Γράφεις.', ['γράφεις'], el)).toBe(true);
    expect(gradeSpokenForm('книгам', ['книгами'], ru)).toBe(false);
  });
});

describe('forms settings', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to nouns, typing and 10 words', () => {
    expect(getFormsKinds()).toEqual(['noun']);
    expect(getFormsMode()).toBe('type');
    expect(getFormsCount()).toBe(10);
  });

  it('reads stored values and ignores bad ones', () => {
    store.set(FORMS_KINDS_KEY, 'verb,noun,adjective');
    store.set(FORMS_MODE_KEY, 'voice');
    store.set(FORMS_COUNT_KEY, '20');
    expect(getFormsKinds()).toEqual(['verb', 'noun']);
    expect(getFormsMode()).toBe('voice');
    expect(getFormsCount()).toBe(20);
    store.set(FORMS_COUNT_KEY, '15');
    store.set(FORMS_KINDS_KEY, '');
    expect(getFormsCount()).toBe(10);
    expect(getFormsKinds()).toEqual(['noun']);
  });

  it('sends kinds and count, and raises the error code', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: 'No tables', code: 'NO_ITEMS' }, { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await fetchFormsRound(['noun', 'verb'], 20).catch((e) => e);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/api/forms/round?kinds=noun%2Cverb&count=20&language=');
    expect(error).toBeInstanceOf(FormsError);
    expect(error).toMatchObject({ message: 'No tables', code: 'NO_ITEMS' });
  });
});
