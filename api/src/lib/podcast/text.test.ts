import '../../test-guard';
import { describe, expect, test } from 'bun:test';
import { getLanguageConfig } from '../languages';
import { narrationRuns, paragraphSentences, podcastParagraphs } from './text';

const ru = getLanguageConfig('ru');

describe('podcastParagraphs', () => {
  test('splits on blank lines and drops headings, rules and code fences', () => {
    const markdown = [
      '# Глава первая',
      '',
      'Кот видит **дом**. Дом большой.',
      '',
      '---',
      '',
      '> — Да, — сказал он.',
      '',
      '```',
      '',
      '![cover](cover.jpg)',
    ].join('\n');
    expect(podcastParagraphs(markdown)).toEqual([
      'Кот видит дом. Дом большой.',
      '— Да, — сказал он.',
    ]);
  });

  test('joins wrapped lines and keeps link text', () => {
    expect(podcastParagraphs('Он [читал](https://x.test)\nкнигу.\r\n\r\n- Пункт')).toEqual([
      'Он читал книгу.',
      'Пункт',
    ]);
  });

  test('returns nothing for a lesson without readable text', () => {
    expect(podcastParagraphs('## Title\n\n---\n\n')).toEqual([]);
  });
});

describe('paragraphSentences', () => {
  test('splits a paragraph into sentences', () => {
    expect(paragraphSentences('Кот видит дом. Дом большой!', ru)).toEqual([
      'Кот видит дом.',
      'Дом большой!',
    ]);
  });
});

describe('narrationRuns', () => {
  test('gives English and target runs, without guillemets or empty parts', () => {
    expect(narrationRuns('The verb «видит» comes from «видеть», to see.')).toEqual([
      { text: 'The verb', voice: 'en' },
      { text: 'видит', voice: 'target' },
      { text: 'comes from', voice: 'en' },
      { text: 'видеть', voice: 'target' },
      { text: ', to see.', voice: 'en' },
    ]);
  });

  test('drops punctuation-only parts', () => {
    expect(narrationRuns('«дом».')).toEqual([{ text: 'дом', voice: 'target' }]);
  });
});
