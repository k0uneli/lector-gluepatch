import { describe, expect, it } from 'vitest';
import { matchVoiceAnswer } from '../utils';
import { LANGUAGES } from '@/lib/languages';

const af = LANGUAGES.af;

const card = (sentence: string, clozeIndex: number, tokens: string[] | null = null) => {
  const words = tokens ?? sentence.split(/\s+/);
  return { sentence, tokens, clozeIndex, clozeWord: words[clozeIndex] };
};

describe('matchVoiceAnswer', () => {
  const dog = card('Die bruin hond hardloop vinnig.', 3);

  it('accepts the missing word said alone, ignoring case and punctuation', () => {
    expect(matchVoiceAnswer('hardloop', dog, af)).toBe(true);
    expect(matchVoiceAnswer('Hardloop.', dog, af)).toBe(true);
  });

  it('accepts the whole sentence', () => {
    expect(matchVoiceAnswer('Die bruin hond hardloop vinnig.', dog, af)).toBe(true);
  });

  it('accepts the whole sentence despite a misheard neighbour', () => {
    expect(matchVoiceAnswer('die bruin hont hardloop vinnig', dog, af)).toBe(true);
  });

  it('rejects a wrong word, a partial word, and silence', () => {
    expect(matchVoiceAnswer('loop', dog, af)).toBe(false);
    expect(matchVoiceAnswer('Die bruin hond loop vinnig.', dog, af)).toBe(false);
    expect(matchVoiceAnswer('', dog, af)).toBe(false);
  });

  it('keeps trailing punctuation on the answer out of the match', () => {
    expect(matchVoiceAnswer('vinnig', card('Die bruin hond hardloop vinnig.', 4), af)).toBe(true);
  });

  describe('when the answer also appears elsewhere in the sentence', () => {
    const cat = card('die hond sien die kat', 3);

    it('accepts the word alone', () => {
      expect(matchVoiceAnswer('die', cat, af)).toBe(true);
    });

    it('accepts the whole sentence', () => {
      expect(matchVoiceAnswer('die hond sien die kat', cat, af)).toBe(true);
    });

    it('rejects the sentence read with a wrong word in the blank', () => {
      expect(matchVoiceAnswer('die hond sien n kat', cat, af)).toBe(false);
    });
  });

  it('matches unspaced scripts by containment', () => {
    const zh = card('我喜欢喝茶。', 2, ['我', '喜欢', '喝', '茶', '。']);
    expect(matchVoiceAnswer('我喜欢喝茶', zh, LANGUAGES.zh)).toBe(true);
    expect(matchVoiceAnswer('喝', zh, LANGUAGES.zh)).toBe(true);
    expect(matchVoiceAnswer('我喜欢吃茶', zh, LANGUAGES.zh)).toBe(false);
  });

  it('applies the pack leniency, so Ancient Greek ignores marks', () => {
    const grc = card('ὁ λόγος ἀληθής ἐστιν', 1);
    expect(matchVoiceAnswer('λογος', grc, LANGUAGES.grc)).toBe(true);
  });
});
