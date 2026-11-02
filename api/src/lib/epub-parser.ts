import AdmZip from 'adm-zip';
import path from 'path';
import { htmlToMarkdown, countWords } from './html-to-markdown';
import { normalizeText, type LanguageConfig } from './languages';

export interface EpubChapter {
  title: string;
  markdown: string;
  wordCount: number;
}

export interface ParsedEpub {
  title: string;
  author: string;
  chapters: EpubChapter[];
}

// Bound decompression so a zip bomb (a tiny archive that inflates to gigabytes)
// can't exhaust memory when we call getData()/readAsText() below. We check the
// declared uncompressed sizes from the central directory before inflating.
const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * `pack` is the language the chapters will be imported as. It only affects
 * `wordCount` (#289 4.6): an unspaced-CJK EPUB counts segmenter tokens, every
 * other script keeps the whitespace count. Omitting it gives the spaced count.
 */
export function parseEpub(buffer: Buffer, pack?: LanguageConfig): ParsedEpub {
  const zip = new AdmZip(buffer);

  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) {
    throw new Error('EPUB has too many entries');
  }
  let declaredBytes = 0;
  for (const entry of entries) {
    declaredBytes += entry.header.size;
    if (declaredBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('EPUB content exceeds the size limit');
    }
  }

  const containerXml = zip.readAsText('META-INF/container.xml');
  const opfPathMatch = containerXml.match(/full-path="([^"]+)"/);
  if (!opfPathMatch) {
    throw new Error('Could not find OPF file path in container.xml');
  }
  const opfPath = opfPathMatch[1];
  const opfDir = path.dirname(opfPath);

  const opfXml = zip.readAsText(opfPath);

  // Text ingress (#289): chapter markdown is normalized inside htmlToMarkdown;
  // metadata and TOC titles come straight from the XML, so normalize here.
  const title = normalizeText(
    extractTag(opfXml, 'dc:title') || extractTag(opfXml, 'title') || 'Untitled',
  );
  const author = normalizeText(
    extractTag(opfXml, 'dc:creator') || extractTag(opfXml, 'creator') || 'Unknown',
  );

  const manifest = new Map<string, string>();
  const manifestRegex =
    /<item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*(?:media-type="([^"]+)")?[^>]*\/?>/g;
  let match;
  while ((match = manifestRegex.exec(opfXml)) !== null) {
    manifest.set(match[1], match[2]);
  }

  const manifestRegex2 = /<item\s+[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*\/?>/g;
  while ((match = manifestRegex2.exec(opfXml)) !== null) {
    if (!manifest.has(match[2])) {
      manifest.set(match[2], match[1]);
    }
  }

  const spineItemRefs: string[] = [];
  const spineRegex = /<itemref\s+[^>]*idref="([^"]+)"[^>]*\/?>/g;
  while ((match = spineRegex.exec(opfXml)) !== null) {
    // linear="no" marks pages outside the reading order, such as a cover image.
    if (/\slinear="no"/.test(match[0])) continue;
    spineItemRefs.push(match[1]);
  }

  const chapters: EpubChapter[] = [];
  const toc = parseToc(zip, opfXml, opfDir);

  for (const itemRef of spineItemRefs) {
    const href = manifest.get(itemRef);
    if (!href) continue;

    const filePath = zipPath(opfDir, href);
    const entry = zip.getEntry(filePath) || zip.getEntry(href);
    if (!entry) continue;

    const xhtml = entry.getData().toString('utf-8');

    const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : xhtml;

    for (const section of splitSections(
      bodyHtml,
      toc.filter((t) => t.file === filePath),
    )) {
      const markdown = htmlToMarkdown(section.html).trim();
      if (!markdown || markdown.length < 10) continue;

      const headingMatch = markdown.match(/^#+\s+(.+)$/m);
      const chapterTitle = normalizeText(
        section.title || headingMatch?.[1] || `Chapter ${chapters.length + 1}`,
      );
      chapters.push({ title: chapterTitle, markdown, wordCount: countWords(markdown, pack) });
    }
  }

  return { title, author, chapters };
}

function extractTag(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]+)</${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

/** A table-of-contents entry. `file` is the zip path; `depth` 1 is the top level. */
interface TocEntry {
  file: string;
  fragment: string | null;
  title: string;
  depth: number;
}

function zipPath(dir: string, href: string): string {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    /* keep the raw href */
  }
  return path.posix.normalize(dir && dir !== '.' ? `${dir}/${decoded}` : decoded);
}

function tocEntry(tocDir: string, src: string, title: string, depth: number): TocEntry | null {
  const [file, fragment] = src.split('#');
  const label = normalizeText(
    title
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (!file || !label) return null;
  return { file: zipPath(tocDir, file), fragment: fragment || null, title: label, depth };
}

/** NCX navPoints in document order, with their nesting depth. */
function parseNcx(ncxXml: string, ncxDir: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const open: Array<{ title: string | null; src: string | null; depth: number }> = [];
  const tokens =
    /<navPoint\b[^>]*>|<\/navPoint>|<text>([\s\S]*?)<\/text>|<content\s[^>]*src="([^"]+)"/g;
  let match;
  while ((match = tokens.exec(ncxXml)) !== null) {
    const top = open[open.length - 1];
    if (match[0].startsWith('<navPoint')) {
      open.push({ title: null, src: null, depth: open.length + 1 });
    } else if (match[0] === '</navPoint>') {
      open.pop();
    } else if (match[1] !== undefined) {
      if (top && top.title === null) top.title = match[1];
    } else if (top && top.src === null) {
      top.src = match[2];
      const entry = tocEntry(ncxDir, top.src, top.title ?? '', top.depth);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/** EPUB 3 nav links in document order. Depth counts the nested lists. */
function parseNav(navHtml: string, navDir: string): TocEntry[] {
  const tocNav = navHtml.match(/<nav\b[^>]*epub:type="toc"[^>]*>([\s\S]*?)<\/nav>/i);
  const html = tocNav ? tocNav[1] : navHtml;
  const entries: TocEntry[] = [];
  let depth = 0;
  const tokens = /<ol\b[^>]*>|<\/ol>|<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = tokens.exec(html)) !== null) {
    if (match[0].startsWith('<ol')) depth++;
    else if (match[0] === '</ol>') depth--;
    else {
      const entry = tocEntry(navDir, match[1], match[2], Math.max(depth, 1));
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function parseToc(zip: AdmZip, opfXml: string, opfDir: string): TocEntry[] {
  const ncxMatch =
    opfXml.match(/<item[^>]*id="ncx"[^>]*href="([^"]+)"[^>]*\/?>/i) ||
    opfXml.match(/<item[^>]*href="([^"]+)"[^>]*id="ncx"[^>]*\/?>/i) ||
    opfXml.match(
      /<item[^>]*media-type="application\/x-dtbncx\+xml"[^>]*href="([^"]+)"[^>]*\/?>/i,
    ) ||
    opfXml.match(/<item[^>]*href="([^"]+)"[^>]*media-type="application\/x-dtbncx\+xml"[^>]*\/?>/i);

  if (ncxMatch) {
    const ncxPath = zipPath(opfDir, ncxMatch[1]);
    const ncxEntry = zip.getEntry(ncxPath) || zip.getEntry(ncxMatch[1]);
    if (ncxEntry) {
      const entries = parseNcx(ncxEntry.getData().toString('utf-8'), path.posix.dirname(ncxPath));
      if (entries.length > 0) return entries;
    }
  }

  const navMatch =
    opfXml.match(/<item[^>]*properties="nav"[^>]*href="([^"]+)"[^>]*\/?>/i) ||
    opfXml.match(/<item[^>]*href="([^"]+)"[^>]*properties="nav"[^>]*\/?>/i);
  if (navMatch) {
    const navPath = zipPath(opfDir, navMatch[1]);
    const navEntry = zip.getEntry(navPath) || zip.getEntry(navMatch[1]);
    if (navEntry)
      return parseNav(navEntry.getData().toString('utf-8'), path.posix.dirname(navPath));
  }
  return [];
}

/** Average text length, in characters, below which a file is not split at its anchors. */
const MIN_SECTION_CHARS = 1000;

interface Section {
  title: string | null;
  html: string;
}

/** Start of the tag that carries `id` (or a legacy `name`) equal to `fragment`, or -1. */
function anchorStart(html: string, fragment: string): number {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\s(?:id|name)=["']${escaped}["']`).exec(html);
  return match ? html.lastIndexOf('<', match.index) : -1;
}

/** True when the HTML holds only headings, images and whitespace. */
function headingOnly(html: string): boolean {
  const withoutHeadings = html.replace(/<h[1-6]\b[\s\S]*?<\/h[1-6]>/gi, '');
  return withoutHeadings.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '') === '';
}

/**
 * One file's chapters. When the table of contents points inside the file, it
 * is cut at the shallowest level of those anchors; deeper entries stay inside
 * their section. A section that is only a heading joins the one after it.
 */
function splitSections(bodyHtml: string, entries: TocEntry[]): Section[] {
  const fileTitle = entries.find((e) => e.fragment === null)?.title ?? entries[0]?.title ?? null;
  const anchored = entries
    .filter((e) => e.fragment !== null)
    .map((e) => ({ ...e, start: anchorStart(bodyHtml, e.fragment!) }))
    .filter((e) => e.start >= 0);
  if (anchored.length === 0) return [{ title: fileTitle, html: bodyHtml }];

  const level = Math.min(...anchored.map((e) => e.depth));
  const cuts = anchored
    .filter((e) => e.depth === level)
    .sort((a, b) => a.start - b.start)
    .filter((e, i, all) => i === 0 || e.start !== all[i - 1].start);
  // A table of contents can index every entry of a glossary or dictionary;
  // pieces that small are not chapters.
  const textLength = bodyHtml
    .slice(cuts[0].start)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ').length;
  if (textLength / cuts.length < MIN_SECTION_CHARS) return [{ title: fileTitle, html: bodyHtml }];

  const pieces: Array<Section & { fromAnchor: boolean }> = [];
  if (cuts[0].start > 0) {
    pieces.push({ title: fileTitle, html: bodyHtml.slice(0, cuts[0].start), fromAnchor: false });
  }
  cuts.forEach((cut, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1].start : bodyHtml.length;
    pieces.push({ title: cut.title, html: bodyHtml.slice(cut.start, end), fromAnchor: true });
  });

  const sections: Section[] = [];
  let pending: Array<Section & { fromAnchor: boolean }> = [];
  for (const piece of pieces) {
    pending.push(piece);
    if (headingOnly(piece.html)) continue;
    sections.push({
      title: (pending.find((p) => p.fromAnchor) ?? pending[0]).title,
      html: pending.map((p) => p.html).join(''),
    });
    pending = [];
  }
  if (pending.length > 0) {
    const last = sections[sections.length - 1];
    if (last) last.html += pending.map((p) => p.html).join('');
    else sections.push({ title: pending[0].title, html: pending.map((p) => p.html).join('') });
  }
  return sections;
}
