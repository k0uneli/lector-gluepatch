import { describe, it, expect } from 'vitest';
import {
  activeNoteFormat,
  audioFieldNames,
  formatPhraseDetails,
  formatStructuredEntry,
  guessFieldMapping,
  isClozeFormat,
  pickWordDefinitions,
  renderNoteFields,
  type AnkiNoteFormat,
} from './anki-formats';
import { customFieldNamesByModel } from './anki';
import { getLanguageConfig } from './languages';

const ru = getLanguageConfig('ru');

const wordFormat: AnkiNoteFormat = {
  modelName: 'Mining',
  fields: {
    Expression: 'word',
    Sentence: 'sentence',
    MainDefinition: 'definition',
    Glossary: 'definition2',
    Picture: 'image',
    ExpressionAudio: 'audio',
  },
};

describe('guessFieldMapping', () => {
  it('maps common field names and leaves the rest unmapped', () => {
    expect(
      guessFieldMapping(
        ['Expression', 'Sentence', 'MainDefinition', 'Picture', 'ExpressionAudio', 'Frequency'],
        'word',
      ),
    ).toEqual({
      Expression: 'word',
      Sentence: 'sentence',
      MainDefinition: 'definition',
      Picture: 'image',
      ExpressionAudio: 'audio',
    });
  });

  it('matches word audio to word cards and sentence audio to sentence cards', () => {
    const fields = ['WordAudio', 'SentenceAudio'];
    expect(guessFieldMapping(fields, 'word')).toEqual({ WordAudio: 'audio' });
    expect(guessFieldMapping(fields, 'sentence')).toEqual({ SentenceAudio: 'audio' });
  });

  it('maps a Cloze note type Text field to the cloze sentence', () => {
    expect(guessFieldMapping(['Text', 'Extra'], 'sentence')).toEqual({
      Text: 'sentenceCloze',
      Extra: 'definition2',
    });
  });
});

describe('activeNoteFormat', () => {
  it('returns the format for the language and card kind', () => {
    expect(activeNoteFormat({ ru: { word: wordFormat } }, 'ru', 'word')).toBe(wordFormat);
  });

  it('falls back (null) for another language, a missing kind, or no mapped fields', () => {
    const formats = { ru: { word: wordFormat, sentence: { modelName: 'Empty', fields: {} } } };
    expect(activeNoteFormat(formats, 'el', 'word')).toBeNull();
    expect(activeNoteFormat({ ru: { word: wordFormat } }, 'ru', 'sentence')).toBeNull();
    expect(activeNoteFormat(formats, 'ru', 'sentence')).toBeNull();
  });
});

describe('renderNoteFields', () => {
  const content = {
    word: 'слишком,',
    sentence: 'Президент слишком быстро выздоравливает.',
    definition: 'too',
    definition2: '<ol><li>too much</li></ol>',
  };

  it('fills each mapped field, bolding the word and leaving image and audio empty', () => {
    expect(renderNoteFields(wordFormat, content, ru)).toEqual({
      Expression: 'слишком',
      Sentence: 'Президент <b>слишком</b> быстро выздоравливает.',
      MainDefinition: 'too',
      Glossary: '<ol><li>too much</li></ol>',
      Picture: '',
      ExpressionAudio: '',
    });
  });

  it('blanks the word in a cloze field', () => {
    const format: AnkiNoteFormat = { modelName: 'Cloze', fields: { Text: 'sentenceCloze' } };
    expect(renderNoteFields(format, content, ru).Text).toBe(
      'Президент {{c1::слишком}} быстро выздоравливает.',
    );
  });

  it('throws when a cloze field has no word to blank', () => {
    const format: AnkiNoteFormat = { modelName: 'Cloze', fields: { Text: 'sentenceCloze' } };
    expect(() => renderNoteFields(format, { ...content, word: 'нет' }, ru)).toThrow(/not found/);
    expect(() => renderNoteFields(format, { ...content, word: '' }, ru)).toThrow(/Pick a word/);
  });

  it('keeps a sentence card without a target word as plain text', () => {
    const format: AnkiNoteFormat = { modelName: 'S', fields: { Sentence: 'sentence' } };
    expect(renderNoteFields(format, { ...content, word: '' }, ru).Sentence).toBe(content.sentence);
  });

  it('fills Word with the sentence when there is no target word', () => {
    const format: AnkiNoteFormat = {
      modelName: 'vocabsieve-notes-with-url',
      fields: { Word: 'word', Sentence: 'sentence' },
    };
    expect(renderNoteFields(format, { ...content, word: '' }, ru)).toEqual({
      Word: content.sentence,
      Sentence: content.sentence,
    });
  });

  it('isolates target-language text for right-to-left packs', () => {
    const format: AnkiNoteFormat = { modelName: 'W', fields: { Word: 'word' } };
    const ar = getLanguageConfig('ar');
    expect(renderNoteFields(format, { ...content, word: 'كتاب' }, ar).Word).toBe('<bdi>كتاب</bdi>');
  });
});

describe('format helpers', () => {
  it('reports cloze formats and audio fields', () => {
    expect(isClozeFormat(wordFormat)).toBe(false);
    expect(isClozeFormat({ modelName: 'C', fields: { Text: 'sentenceCloze' } })).toBe(true);
    expect(audioFieldNames(wordFormat)).toEqual(['ExpressionAudio']);
  });

  it('renders the full AI entry with escaped text', () => {
    expect(
      formatStructuredEntry({
        senses: [
          { partOfSpeech: 'adverb', gloss: 'too' },
          { partOfSpeech: '', gloss: 'excessively <very>' },
        ],
        ipa: 'ˈslʲiʂkəm',
        etymology: 'From Old East Slavic',
      }),
    ).toBe(
      'ˈslʲiʂkəm<br><ol><li><i>adverb</i> too</li><li>excessively &lt;very&gt;</li></ol><br><small>From Old East Slavic</small>',
    );
  });

  it('renders the phrase breakdown and skips absent parts', () => {
    expect(formatPhraseDetails(null)).toBe('');
    expect(
      formatPhraseDetails({ idiomaticMeaning: 'recovering too fast', usageNotes: 'news style' }),
    ).toBe('<b>Meaning:</b> recovering too fast<br><b>Usage:</b> news style');
  });
});

describe('pickWordDefinitions', () => {
  const dictEntry = { senses: [{ partOfSpeech: 'adverb', gloss: 'too' }], source: 'dict' as const };
  const empty = {
    translation: null,
    aiContextTranslation: null,
    aiStructured: null,
    dictEntry: null,
  };

  it('uses the on-device dictionary by default, with no Definition #2', () => {
    expect(pickWordDefinitions({ ...empty, dictEntry, translation: 'too; overly' })).toEqual({
      definition: 'too',
      definition2: '',
    });
  });

  it('lets an AI result supersede the dictionary', () => {
    expect(
      pickWordDefinitions({ ...empty, dictEntry, aiContextTranslation: 'excessively' }).definition,
    ).toBe('excessively');
  });

  it('puts the full AI entry in Definition #2', () => {
    const aiStructured = { senses: [{ partOfSpeech: 'adverb', gloss: 'too' }] };
    expect(pickWordDefinitions({ ...empty, aiStructured })).toEqual({
      definition: 'too',
      definition2: '<ol><li><i>adverb</i> too</li></ol>',
    });
  });

  it('treats an AI entry learned into the on-device cache as AI', () => {
    const cached = { ...dictEntry, source: 'cache' as const };
    expect(pickWordDefinitions({ ...empty, dictEntry: cached }).definition2).toBe(
      '<ol><li><i>adverb</i> too</li></ol>',
    );
  });

  it('falls back to the plain translation', () => {
    expect(pickWordDefinitions({ ...empty, translation: 'too' }).definition).toBe('too');
  });
});

describe('customFieldNamesByModel', () => {
  it('collects the word, sentence and definition fields per note type', () => {
    const byModel = customFieldNamesByModel({
      ru: {
        word: wordFormat,
        sentence: { modelName: 'Cloze+', fields: { Text: 'sentenceCloze', Target: 'word' } },
      },
    });
    expect(byModel.get('Mining')).toEqual({
      word: 'Expression',
      sentence: 'Sentence',
      definition: 'MainDefinition',
    });
    expect(byModel.get('Cloze+')).toEqual({ word: 'Target', sentence: 'Text' });
  });
});
