import { describe, expect, it } from 'vitest';
import { isSpeakable, splitNarration } from './narration';

describe('splitNarration', () => {
  it('marks «» spans as target text and keeps the guillemets outside', () => {
    expect(splitNarration('The word «huis» means house.')).toEqual([
      { text: 'The word «', target: false },
      { text: 'huis', target: true },
      { text: '» means house.', target: false },
    ]);
  });

  it('handles several spans and a span at the start', () => {
    expect(splitNarration('«слышу» comes from «слышать».')).toEqual([
      { text: '«', target: false },
      { text: 'слышу', target: true },
      { text: '» comes from «', target: false },
      { text: 'слышать', target: true },
      { text: '».', target: false },
    ]);
  });

  it('treats non-Latin words outside guillemets as target text', () => {
    expect(splitNarration('Here мы видим the dative.')).toEqual([
      { text: 'Here ', target: false },
      { text: 'мы видим', target: true },
      { text: ' the dative.', target: false },
    ]);
  });

  it('keeps an unclosed guillemet as plain text', () => {
    expect(splitNarration('A stray « mark')).toEqual([{ text: 'A stray « mark', target: false }]);
  });

  it('keeps a blank span as plain text', () => {
    expect(splitNarration('Empty «  » span')).toEqual([{ text: 'Empty «  » span', target: false }]);
  });

  it('returns English-only text as one part', () => {
    expect(splitNarration('No target words here.')).toEqual([
      { text: 'No target words here.', target: false },
    ]);
  });
});

describe('isSpeakable', () => {
  it('needs a letter or a digit', () => {
    expect(isSpeakable('» , «')).toBe(false);
    expect(isSpeakable('word')).toBe(true);
    expect(isSpeakable('слово')).toBe(true);
    expect(isSpeakable('7')).toBe(true);
  });
});
