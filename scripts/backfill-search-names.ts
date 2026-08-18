/**
 * Backfills Place.nameNormalized. Idempotent.
 *
 * Search runs against this column because SQLite cannot strip diacritics, so
 * "poznan" never matched "Poznań".
 */

import Database from "better-sqlite3";
import path from "path";
import { normalizeForSearch } from "../src/lib/taxonomy";

const dbPath = resolveDbPath();
console.log(`database: ${dbPath}\n`);

const db = new Database(dbPath);

const rows = db
  .prepare("SELECT id, name, nameNormalized FROM Place")
  .all() as Array<{ id: string; name: string; nameNormalized: string }>;

const update = db.prepare("UPDATE Place SET nameNormalized = ? WHERE id = ?");

let changed = 0;
const run = db.transaction(() => {
  for (const row of rows) {
    const normalized = normalizeForSearch(row.name);
    if (row.nameNormalized !== normalized) {
      update.run(normalized, row.id);
      changed++;
    }
  }
});

run();

console.log(`rows: ${rows.length}`);
console.log(`updated: ${changed}`);

const sample = db
  .prepare(
    "SELECT name, nameNormalized FROM Place WHERE nameNormalized LIKE '%pozna%' LIMIT 5"
  )
  .all();
console.log("poznan matches:", JSON.stringify(sample, null, 1));

db.close();

function resolveDbPath(): string {
  const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  const file = url.startsWith("file:") ? url.slice(5) : url;
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}
