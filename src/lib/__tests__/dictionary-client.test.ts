import { describe, expect, test } from 'vitest';
import { entryMeaning } from '../dictionary-client';

const senses = (...glosses: string[]) => glosses.map((gloss) => ({ partOfSpeech: 'verb', gloss }));

describe('entryMeaning', () => {
  test('joins the glosses of an ordinary entry', () => {
    expect(entryMeaning({ senses: senses('fruit', 'produce') })).toBe('fruit; produce');
  });

  test('leads a form-of entry with the lemma meaning', () => {
    expect(
      entryMeaning({
        senses: senses('plural past indicative of стать', 'inflection of сталь:'),
        lemmaEntries: [
          { word: 'стать', senses: senses('to become', 'to stand') },
          { word: 'сталь', senses: senses('steel') },
        ],
      }),
    ).toBe('to become; to stand — plural past indicative of стать; inflection of сталь:');
  });

  test('takes the first `count` glosses from each part', () => {
    expect(
      entryMeaning(
        {
          senses: senses('plural past indicative of стать', 'inflection of сталь:'),
          lemmaEntries: [{ word: 'стать', senses: senses('to become', 'to stand') }],
        },
        1,
      ),
    ).toBe('to become — plural past indicative of стать');
  });
});
