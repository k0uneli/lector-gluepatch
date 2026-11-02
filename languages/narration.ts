/**
 * Podcast narration lines are English with target-language words wrapped in
 * «…». The API splits them into voice runs; the listen-along transcript renders
 * the target runs as interactive words.
 */
export interface NarrationPart {
  text: string;
  /** True for target-language text. Guillemets stay in the non-target parts. */
  target: boolean;
}

// A run of non-Latin words: Cyrillic, Greek, Han, Arabic and so on. Latin-script
// target languages cannot be told apart from English, so they rely on «».
const NON_LATIN_RUN =
  /(?:(?!\p{Script=Latin})[\p{L}\p{M}])+(?:[\s\-'’]+(?:(?!\p{Script=Latin})[\p{L}\p{M}])+)*/gu;

function pushPart(parts: NarrationPart[], text: string, target: boolean) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.target === target && !target) last.text += text;
  else parts.push({ text, target });
}

function splitScript(parts: NarrationPart[], text: string) {
  let cursor = 0;
  for (const match of text.matchAll(NON_LATIN_RUN)) {
    pushPart(parts, text.slice(cursor, match.index), false);
    pushPart(parts, match[0], true);
    cursor = match.index + match[0].length;
  }
  pushPart(parts, text.slice(cursor), false);
}

export function splitNarration(text: string): NarrationPart[] {
  const parts: NarrationPart[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('«', cursor);
    const close = open === -1 ? -1 : text.indexOf('»', open + 1);
    if (open === -1 || close === -1) {
      splitScript(parts, text.slice(cursor));
      break;
    }
    splitScript(parts, text.slice(cursor, open + 1));
    const inner = text.slice(open + 1, close);
    pushPart(parts, inner, inner.trim() !== '');
    pushPart(parts, '»', false);
    cursor = close + 1;
  }
  return parts;
}

/** True when the text has a letter or digit, i.e. something a voice can say. */
export function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
