/**
 * Phase 1 data migration. Idempotent — safe to re-run.
 *
 * 1. Seeds the Category taxonomy.
 * 2. Links every Place to a taxonomy category via categoryId.
 * 3. Re-tags bulk-imported Wikivoyage rows as REFERENCE rather than MANUAL,
 *    so they stop masquerading as places the user saved (spec §33).
 * 4. Creates a PlaceSource row for each place that has none, preserving where
 *    it came from (spec §15).
 * 5. Migrates the legacy `tags` JSON column into Tag / PlaceTag rows.
 *
 * Verifies row counts before and after and refuses to proceed if the place
 * count changes.
 */

import Database from "better-sqlite3";
import path from "path";
import { CATEGORIES, legacyCategoryToId } from "../src/lib/taxonomy";

const dbPath = resolveDbPath();
console.log(`database: ${dbPath}\n`);

const db = new Database(dbPath);

const before = db.prepare("SELECT COUNT(*) c FROM Place").get() as { c: number };
console.log(`places before: ${before.c}`);

db.pragma("foreign_keys = ON");

const migrate = db.transaction(() => {
  // --- 1. taxonomy ------------------------------------------------------
  const upsertCategory = db.prepare(
    `INSERT INTO Category (id, label, icon, color, sort) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label=excluded.label, icon=excluded.icon,
                                   color=excluded.color, sort=excluded.sort`
  );
  for (const c of CATEGORIES) {
    upsertCategory.run(c.id, c.label, c.icon, c.color, c.sort);
  }
  console.log(`categories seeded: ${CATEGORIES.length}`);

  // --- 2. link places to taxonomy --------------------------------------
  const rows = db
    .prepare("SELECT id, category, source, tags, categoryId, sourceType FROM Place")
    .all() as Array<{
    id: string;
    category: string;
    source: string;
    tags: string;
    categoryId: string | null;
    sourceType: string;
  }>;

  const setCategory = db.prepare("UPDATE Place SET categoryId = ? WHERE id = ?");
  let linked = 0;
  for (const r of rows) {
    const target = legacyCategoryToId(r.category);
    if (r.categoryId !== target) {
      setCategory.run(target, r.id);
      linked++;
    }
  }
  console.log(`categoryId linked: ${linked}`);

  // --- 3. reclassify bulk reference data -------------------------------
  // Wikivoyage rows were bulk-seeded as a discovery corpus, not saved by the
  // user. Leaving them as MANUAL makes 9320 places look like personal saves.
  const reference = db
    .prepare(
      `UPDATE Place SET sourceType = 'REFERENCE'
       WHERE source = 'wikivoyage' AND sourceType != 'REFERENCE'`
    )
    .run();
  console.log(`re-tagged as REFERENCE: ${reference.changes}`);

  // Places imported from Google Takeout are genuinely the user's.
  const imported = db
    .prepare(
      `UPDATE Place SET sourceType = 'IMPORTED'
       WHERE source = 'google' AND sourceType NOT IN ('IMPORTED','PERSONAL')`
    )
    .run();
  console.log(`re-tagged as IMPORTED: ${imported.changes}`);

  // Anything saved from a social platform is personal.
  const personal = db
    .prepare(
      `UPDATE Place SET sourceType = 'PERSONAL'
       WHERE source IN ('tiktok','instagram','social') AND sourceType != 'PERSONAL'`
    )
    .run();
  console.log(`re-tagged as PERSONAL: ${personal.changes}`);

  // --- 4. backfill PlaceSource -----------------------------------------
  const missingSource = db
    .prepare(
      `SELECT p.id, p.source, p.imageUrl, p.createdAt
       FROM Place p
       LEFT JOIN PlaceSource s ON s.placeId = p.id
       WHERE s.id IS NULL`
    )
    .all() as Array<{
    id: string;
    source: string;
    imageUrl: string | null;
    createdAt: string;
  }>;

  const insertSource = db.prepare(
    `INSERT INTO PlaceSource (id, placeId, platform, thumbnailUrl, savedAt)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const p of missingSource) {
    insertSource.run(
      cuidish(),
      p.id,
      p.source || "manual",
      p.imageUrl,
      p.createdAt
    );
  }
  console.log(`PlaceSource backfilled: ${missingSource.length}`);

  // --- 5. legacy tags -> Tag / PlaceTag ---------------------------------
  const findTag = db.prepare("SELECT id FROM Tag WHERE name = ?");
  const insertTag = db.prepare("INSERT INTO Tag (id, name) VALUES (?, ?)");
  const linkTag = db.prepare(
    "INSERT OR IGNORE INTO PlaceTag (placeId, tagId) VALUES (?, ?)"
  );

  let tagLinks = 0;
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.tags || "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    for (const raw of parsed) {
      const name = String(raw).trim();
      if (!name) continue;

      let tag = findTag.get(name) as { id: string } | undefined;
      if (!tag) {
        const id = cuidish();
        insertTag.run(id, name);
        tag = { id };
      }
      linkTag.run(r.id, tag.id);
      tagLinks++;
    }
  }
  console.log(`tag links created: ${tagLinks}`);
});

migrate();

// --- verification ---------------------------------------------------------
const after = db.prepare("SELECT COUNT(*) c FROM Place").get() as { c: number };
if (after.c !== before.c) {
  throw new Error(
    `Place count changed during migration: ${before.c} -> ${after.c}. Restore from .backups/.`
  );
}

console.log("\nverification:");
console.log(`  places: ${after.c} (unchanged)`);
for (const t of ["Category", "PlaceSource", "Tag", "PlaceTag"]) {
  const { c } = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number };
  console.log(`  ${t}: ${c}`);
}
const byType = db
  .prepare("SELECT sourceType, COUNT(*) c FROM Place GROUP BY sourceType ORDER BY c DESC")
  .all();
console.log("  sourceType:", JSON.stringify(byType));

const unlinked = db
  .prepare("SELECT COUNT(*) c FROM Place WHERE categoryId IS NULL")
  .get() as { c: number };
console.log(`  places without categoryId: ${unlinked.c}`);

db.close();
console.log("\nmigration complete.");

// --------------------------------------------------------------------------

function resolveDbPath(): string {
  const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  const file = url.startsWith("file:") ? url.slice(5) : url;
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

/** Collision-resistant id in Prisma's cuid shape, without pulling a dependency. */
function cuidish(): string {
  return (
    "c" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}
