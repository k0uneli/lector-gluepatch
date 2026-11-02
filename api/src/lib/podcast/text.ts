import {
  isSpeakable,
  normalizeText,
  splitNarration,
  splitSentences,
  type LanguageConfig,
} from '../languages';

/** Plain text of one markdown block, or null for blocks a narrator skips. */
function plainBlock(block: string): string | null {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(```|~~~)/.test(line));
  if (lines.length === 0) return null;
  if (lines.every((line) => /^#{1,6}\s/.test(line) || /^([-*_]\s*){3,}$/.test(line))) return null;
  const text = lines
    .filter((line) => !/^#{1,6}\s/.test(line))
    .map((line) =>
      line
        .replace(/^>\s?/, '')
        .replace(/^([-*+]|\d+[.)])\s+/, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|\*|`)/g, ''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text && isSpeakable(text) ? normalizeText(text) : null;
}

/** The lesson's paragraphs as narration text, in order. Headings and rules are dropped. */
export function podcastParagraphs(markdown: string): string[] {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map(plainBlock)
    .filter((p): p is string => p !== null);
}

export function paragraphSentences(paragraph: string, pack: LanguageConfig): string[] {
  return splitSentences(paragraph, pack)
    .map((s) => s.trim())
    .filter((s) => s && isSpeakable(s));
}

export type VoiceKind = 'en' | 'target';

export interface VoiceRun {
  text: string;
  voice: VoiceKind;
}

/** English narration split into the runs each voice speaks. */
export function narrationRuns(text: string): VoiceRun[] {
  return splitNarration(text)
    .map((part) => ({
      text: part.target ? part.text.trim() : part.text.replace(/[«»]/g, '').trim(),
      voice: (part.target ? 'target' : 'en') as VoiceKind,
    }))
    .filter((run) => isSpeakable(run.text));
}
