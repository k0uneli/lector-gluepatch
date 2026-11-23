import { describe, expect, it } from 'vitest';
import { getLanguageConfig } from '../languages';
import { diffCorrection } from '../correction-diff';

const ru = getLanguageConfig('ru');
const zh = getLanguageConfig('zh');

describe('diffCorrection', () => {
  it('marks a replaced word as removed then added', () => {
    expect(diffCorrection('Я вижу кот', 'Я вижу кота.', ru)).toEqual([
      { kind: 'same', text: 'Я вижу' },
      { kind: 'removed', text: 'кот' },
      { kind: 'added', text: 'кота' },
    ]);
  });

  it('ignores case and punctuation', () => {
    expect(diffCorrection('привет как дела', 'Привет, как дела?', ru)).toEqual([
      { kind: 'same', text: 'Привет как дела' },
    ]);
  });

  it('shows missing and extra words', () => {
    expect(diffCorrection('Я иду в в магазин', 'Я иду в магазин', ru)).toEqual([
      { kind: 'same', text: 'Я иду в' },
      { kind: 'removed', text: 'в' },
      { kind: 'same', text: 'магазин' },
    ]);
    expect(diffCorrection('Я иду магазин', 'Я иду в магазин', ru)).toEqual([
      { kind: 'same', text: 'Я иду' },
      { kind: 'added', text: 'в' },
      { kind: 'same', text: 'магазин' },
    ]);
  });

  it('joins unspaced scripts without spaces', () => {
    const segments = diffCorrection('我去商店', '我去商店了', zh);
    expect(segments.every((s) => !s.text.includes(' '))).toBe(true);
    expect(segments.at(-1)?.kind).toBe('added');
  });
});
