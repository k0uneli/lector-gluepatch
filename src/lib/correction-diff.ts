import { lowerForPack, tokenize, type LanguageConfig } from './languages';

export interface DiffSegment {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * Word-level diff of a learner turn against its correction. Case and
 * punctuation do not count, since speech transcripts rarely carry them.
 */
export function diffCorrection(
  original: string,
  corrected: string,
  pack: LanguageConfig,
): DiffSegment[] {
  const words = (text: string) => tokenize(text, pack).filter((t) => t.isWord).map((t) => t.text);
  const a = words(original);
  const b = words(corrected);
  const key = (w: string) => lowerForPack(w, pack);

  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        key(a[i]) === key(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment['kind'], text: string) => {
    const last = segments.at(-1);
    const gap = pack.script.kind === 'cjk-unspaced' ? '' : ' ';
    if (last?.kind === kind) last.text += gap + text;
    else segments.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]) === key(b[j])) {
      push('same', b[j]);
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      push('added', b[j++]);
    } else {
      push('removed', a[i++]);
    }
  }
  return reorderRemovals(segments);
}

/** Shows a replaced span as removed-then-added, the order a reader expects. */
function reorderRemovals(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const segment of segments) {
    const last = out.at(-1);
    if (segment.kind === 'removed' && last?.kind === 'added') {
      out.splice(out.length - 1, 0, segment);
    } else {
      out.push(segment);
    }
  }
  return out;
}
