import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";
import { config } from "@/server/config";

/**
 * Prisma singleton.
 *
 * The database location comes from DATABASE_URL and nowhere else. This used to
 * be hardcoded to `<cwd>/prisma/dev.db`, which meant the Prisma CLI (driven by
 * DATABASE_URL) and the application were reading two different files — the
 * migration ledger lived in one and the data in the other, so migrations could
 * never touch live data. Resolving both from the same variable fixes that.
 */

function resolveDatabaseUrl(): string {
  const raw = config.DATABASE_URL;

  // Prisma's SQLite URLs are `file:<path>`, where a relative path is resolved
  // against the schema directory by the CLI but against cwd by the adapter.
  // Normalising to an absolute path here removes that ambiguity.
  if (raw.startsWith("file:")) {
    const filePath = raw.slice("file:".length);
    if (path.isAbsolute(filePath)) return raw;
    // The path comes from an environment variable and is resolved at runtime.
    // Without this hint Turbopack treats it as static filesystem access and
    // traces the entire project into the server bundle, including /public.
    return `file:${path.resolve(/*turbopackIgnore: true*/ process.cwd(), filePath)}`;
  }

  return raw;
}

export const databaseUrl = resolveDatabaseUrl();

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl }) });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
