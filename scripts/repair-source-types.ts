/**
 * Repairs Place rows whose classification/provenance was overwritten.
 *
 * A PATCH that only supplied `notes` used to also write zod's defaults for
 * category, tags, source and sourceType, so reference rows could be flipped to
 * MANUAL and leak into the personal pool. The schema no longer does this; this
 * script restores any row that was affected.
 *
 * Reconstructs sourceType from PlaceSource.platform, which the bug did not
 * touch. Idempotent.
 */

import Database from "better-sqlite3";
import path from "path";
import { legacyCategoryToId } from "../src/lib/taxonomy";

const dbPath = resolveDbPath();
console.log(`database: ${dbPath}\n`);

const db = new Database(dbPath);

const PLATFORM_TO_SOURCE_TYPE: Record<string, string> = {
  wikivoyage: "REFERENCE",
  google: "IMPORTED",
  "google-takeout": "IMPORTED",
  overpass: "DISCOVERED",
  tiktok: "PERSONAL",
  instagram: "PERSONAL",
  social: "PERSONAL",
  manual: "MANUAL",
};

const repair = db.transaction(() => {
  // Rows whose sourceType disagrees with the platform recorded on their source.
  const suspect = db
    .prepare(
      `SELECT p.id, p.name, p.sourceType, p.category, p.source, s.platform
       FROM Place p
       JOIN PlaceSource s ON s.placeId = p.id`
    )
    .all() as Array<{
    id: string;
    name: string;
    sourceType: string;
    category: string;
    source: string;
    platform: string;
  }>;

  const updateRow = db.prepare(
    `UPDATE Place SET sourceType = ?, source = ?, category = ?, categoryId = ?
     WHERE id = ?`
  );
  const clearProvenance = db.prepare(
    `DELETE FROM FieldProvenance
     WHERE placeId = ? AND field IN ('category','categoryId','sourceType','source','tags','isHiddenGem')`
  );

  let repaired = 0;
  for (const row of suspect) {
    const expectedType = PLATFORM_TO_SOURCE_TYPE[row.platform];
    if (!expectedType || row.sourceType === expectedType) continue;

    // Recover the category from the tag list where possible; otherwise leave
    // whatever is there rather than guessing.
    const category = row.category === "other" ? inferCategory(row.id) : row.category;

    updateRow.run(
      expectedType,
      row.platform,
      category,
      legacyCategoryToId(category),
      row.id
    );
    clearProvenance.run(row.id);
    repaired++;
    console.log(
      `  ${row.name}: sourceType ${row.sourceType} -> ${expectedType}, category -> ${category}`
    );
  }

  console.log(`\nrepaired: ${repaired}`);
});

/**
 * Wikivoyage rows carry their listing type as a tag; use it to recover the
 * category the overwrite replaced with "other".
 */
function inferCategory(placeId: string): string {
  const tags = db
    .prepare(
      `SELECT t.name FROM PlaceTag pt JOIN Tag t ON t.id = pt.tagId WHERE pt.placeId = ?`
    )
    .all(placeId) as Array<{ name: string }>;

  const names = tags.map((t) => t.name.toLowerCase());
  if (names.includes("eat")) return "restaurant";
  if (names.includes("drink")) return "cafe";
  if (names.includes("sleep")) return "accommodation";
  if (names.includes("buy")) return "shopping";
  if (names.includes("see") || names.includes("do")) return "attraction";
  return "other";
}

repair();

const byType = db
  .prepare("SELECT sourceType, COUNT(*) c FROM Place GROUP BY sourceType ORDER BY c DESC")
  .all();
console.log("sourceType distribution:", JSON.stringify(byType));

db.close();

function resolveDbPath(): string {
  const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  const file = url.startsWith("file:") ? url.slice(5) : url;
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}
