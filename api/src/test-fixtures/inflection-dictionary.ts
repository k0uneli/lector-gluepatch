import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

export interface DictionaryFixture {
  /** [word, pos, gloss, rank] */
  senses: Array<[string, string, string, number?]>;
  /** [inflected form, lemma, type] */
  inflections: Array<[string, string, string]>;
}

/** Writes `dictionary-<language>.db` with the kaikki schema into `dir`. */
export function writeInflectionDictionary(
  dir: string,
  language: string,
  fixture: DictionaryFixture,
): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dictionary-${language}.db`);
  fs.rmSync(file, { force: true });
  const dict = new Database(file);
  dict.exec(`
    CREATE TABLE entries (word TEXT PRIMARY KEY, rank INTEGER, ipa TEXT, etymology TEXT);
    CREATE TABLE senses (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL, pos TEXT,
      gloss TEXT NOT NULL, sort_order INTEGER DEFAULT 0);
    CREATE TABLE related_forms (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL,
      related_word TEXT NOT NULL, relation TEXT NOT NULL);
    CREATE TABLE inflections (inflected_form TEXT NOT NULL, lemma TEXT NOT NULL, type TEXT,
      PRIMARY KEY (inflected_form, lemma));
  `);
  for (const [word, pos, gloss, rank] of fixture.senses) {
    dict.prepare('INSERT OR IGNORE INTO entries (word, rank) VALUES (?, ?)').run(word, rank ?? null);
    dict.prepare('INSERT INTO senses (word, pos, gloss) VALUES (?, ?, ?)').run(word, pos, gloss);
  }
  for (const [form, lemma, type] of fixture.inflections) {
    dict.prepare('INSERT OR IGNORE INTO inflections VALUES (?, ?, ?)').run(form, lemma, type);
  }
  dict.close();
}
