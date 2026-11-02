import { describe, test, expect } from 'bun:test';
import AdmZip from 'adm-zip';
import { parseEpub } from './epub-parser';

describe('parseEpub DoS guards', () => {
  test('rejects an archive with too many entries (zip-bomb guard)', () => {
    const zip = new AdmZip();
    for (let i = 0; i < 5001; i++) zip.addFile(`f${i}.txt`, Buffer.from('x'));
    expect(() => parseEpub(zip.toBuffer())).toThrow('too many entries');
  });
});

const LONG = 'Λόγια '.repeat(250);

function buildEpub(opts: {
  files: Record<string, string>;
  spine: string[];
  ncx?: string;
  nav?: string;
  nonLinear?: string[];
}): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    ),
  );
  const items = Object.keys(opts.files)
    .map((href) => `<item id="${href}" href="${href}" media-type="application/xhtml+xml"/>`)
    .join('');
  const tocItem = opts.ncx
    ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    : opts.nav
      ? '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'
      : '';
  const spine = opts.spine
    .map((id) => `<itemref idref="${id}"${opts.nonLinear?.includes(id) ? ' linear="no"' : ''}/>`)
    .join('');
  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(
      `<package><metadata><dc:title>Βιβλίο</dc:title><dc:creator>Συγγραφέας</dc:creator></metadata><manifest>${items}${tocItem}</manifest><spine>${spine}</spine></package>`,
    ),
  );
  for (const [href, body] of Object.entries(opts.files)) {
    zip.addFile(`OEBPS/${href}`, Buffer.from(`<html><body>${body}</body></html>`));
  }
  if (opts.ncx) zip.addFile('OEBPS/toc.ncx', Buffer.from(opts.ncx));
  if (opts.nav) zip.addFile('OEBPS/nav.xhtml', Buffer.from(opts.nav));
  return zip.toBuffer();
}

const point = (src: string, title: string, children = '') =>
  `<navPoint><navLabel><text>${title}</text></navLabel><content src="${src}"/>${children}</navPoint>`;

describe('parseEpub chapters', () => {
  test('splits a file at its table-of-contents anchors, keeping deeper entries inside', () => {
    const buffer = buildEpub({
      files: {
        'part1.xhtml': `<h1 id="p1">1. Μέρος</h1><h2 id="s1">Πρώτο</h2><p>${LONG}</p><h3 id="s1a">Υποενότητα</h3><p>${LONG}</p><h2 id="s2">Δεύτερο</h2><p>${LONG}</p>`,
      },
      spine: ['part1.xhtml'],
      ncx: `<ncx><navMap>${point('part1.xhtml', '1. Μέρος', point('part1.xhtml#s1', 'Πρώτο', point('part1.xhtml#s1a', 'Υποενότητα')) + point('part1.xhtml#s2', 'Δεύτερο'))}</navMap></ncx>`,
    });
    const { chapters } = parseEpub(buffer);
    expect(chapters.map((c) => c.title)).toEqual(['Πρώτο', 'Δεύτερο']);
    expect(chapters[0].markdown).toContain('1. Μέρος');
    expect(chapters[0].markdown).toContain('Υποενότητα');
    expect(chapters[1].markdown).not.toContain('Υποενότητα');
  });

  test('keeps text before the first anchor as a chapter with the file title', () => {
    const buffer = buildEpub({
      files: {
        'a.xhtml': `<h1>Εισαγωγή</h1><p>${LONG}</p><h2 id="s1">Ένα</h2><p>${LONG}</p><h2 id="s2">Δύο</h2><p>${LONG}</p>`,
      },
      spine: ['a.xhtml'],
      ncx: `<ncx><navMap>${point('a.xhtml', 'Αρχή')}${point('a.xhtml#s1', 'Ένα')}${point('a.xhtml#s2', 'Δύο')}</navMap></ncx>`,
    });
    expect(parseEpub(buffer).chapters.map((c) => c.title)).toEqual(['Αρχή', 'Ένα', 'Δύο']);
  });

  test('a section that is only a heading joins the next one', () => {
    const buffer = buildEpub({
      files: {
        'a.xhtml': `<h2 id="s1">Ένα</h2><p>${LONG}</p><h2 id="s2">Στοιχεία για την</h2><h2 id="s3">Αμερική</h2><p>${LONG}</p>`,
      },
      spine: ['a.xhtml'],
      ncx: `<ncx><navMap>${point('a.xhtml#s1', 'Ένα')}${point('a.xhtml#s2', 'Στοιχεία για την')}${point('a.xhtml#s3', 'Αμερική')}</navMap></ncx>`,
    });
    const { chapters } = parseEpub(buffer);
    expect(chapters.map((c) => c.title)).toEqual(['Ένα', 'Στοιχεία για την']);
    expect(chapters[1].markdown).toContain('Αμερική');
  });

  test('does not split a file into tiny pieces, such as an indexed glossary', () => {
    const entries = Array.from({ length: 20 }, (_, i) => `<p id="g${i}">Λέξη ${i}: σημασία.</p>`);
    const buffer = buildEpub({
      files: { 'gloss.xhtml': entries.join('') },
      spine: ['gloss.xhtml'],
      ncx: `<ncx><navMap>${point('gloss.xhtml', 'Γλωσσάριο', entries.map((_, i) => point(`gloss.xhtml#g${i}`, `Λέξη ${i}`)).join(''))}</navMap></ncx>`,
    });
    expect(parseEpub(buffer).chapters.map((c) => c.title)).toEqual(['Γλωσσάριο']);
  });

  test('titles a file by its own entry, not the last anchor in it', () => {
    const buffer = buildEpub({
      files: { 'a.xhtml': `<p>${LONG}</p>`, 'b.xhtml': `<p>${LONG}</p>` },
      spine: ['a.xhtml', 'b.xhtml'],
      ncx: `<ncx><navMap>${point('a.xhtml', 'Πρώτο', point('a.xhtml#missing', 'Λείπει'))}${point('b.xhtml', 'Δεύτερο')}</navMap></ncx>`,
    });
    expect(parseEpub(buffer).chapters.map((c) => c.title)).toEqual(['Πρώτο', 'Δεύτερο']);
  });

  test('skips spine items outside the reading order', () => {
    const buffer = buildEpub({
      files: { 'cover.xhtml': '<p>Εξώφυλλο με αρκετό κείμενο</p>', 'a.xhtml': `<p>${LONG}</p>` },
      spine: ['cover.xhtml', 'a.xhtml'],
      nonLinear: ['cover.xhtml'],
      ncx: `<ncx><navMap>${point('a.xhtml', 'Κεφάλαιο')}</navMap></ncx>`,
    });
    expect(parseEpub(buffer).chapters.map((c) => c.title)).toEqual(['Κεφάλαιο']);
  });

  test('reads an EPUB 3 nav with nested lists', () => {
    const buffer = buildEpub({
      files: {
        'a.xhtml': `<h1>Μέρος</h1><h2 id="s1">Ένα</h2><p>${LONG}</p><h2 id="s2">Δύο</h2><p>${LONG}</p>`,
      },
      spine: ['a.xhtml'],
      nav: `<html><body><nav epub:type="toc"><ol><li><a href="a.xhtml">Μέρος</a><ol><li><a href="a.xhtml#s1"><span>Ένα</span></a></li><li><a href="a.xhtml#s2">Δύο</a></li></ol></li></ol></nav><nav epub:type="landmarks"><ol><li><a href="a.xhtml#s2">Landmark</a></li></ol></nav></body></html>`,
    });
    expect(parseEpub(buffer).chapters.map((c) => c.title)).toEqual(['Ένα', 'Δύο']);
  });
});
