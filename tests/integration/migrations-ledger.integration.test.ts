import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasDatabase, pgClient } from "./helpers";

/**
 * "Can this database be rebuilt from the repo?" — the two halves of that
 * question that can be checked mechanically:
 *  1. every migration file that opens a transaction also closes it (a missing
 *     COMMIT once made psql roll back silently with exit code 0 — SESSION_LOG 2026-08-28);
 *  2. every migration file on disk is recorded in the connected database,
 *     except the ones known NOT to replay on a fresh database because they
 *     hard-code production UUIDs or assume prior production data.
 * The allowlist is the honest statement of the gap; shrinking it is the goal.
 */
const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
// One source of truth, shared with scripts/dev-seed/migrate.mjs.
const nonReplayable = JSON.parse(fs.readFileSync(path.join(process.cwd(), "scripts", "dev-seed", "non-replayable.json"), "utf8")) as {
  migrations: Array<{ version: string; reason: string }>;
  duplicateVersions: Array<{ version: string; files: string[] }>;
};
export const KNOWN_NON_REPLAYABLE = new Set(nonReplayable.migrations.map((m) => m.version));
const KNOWN_DUPLICATE_VERSIONS = new Set(nonReplayable.duplicateVersions.map((d) => d.version));

const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const versionOf = (f: string) => f.slice(0, 14);

describe("migration files", () => {
  it("every file that opens a transaction closes it", () => {
    const unbalanced: string[] = [];
    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8").replace(/--.*$/gm, "");
      const begins = (sql.match(/^\s*BEGIN\s*;/gim) ?? []).length;
      const commits = (sql.match(/^\s*COMMIT\s*;/gim) ?? []).length;
      if (begins !== commits) unbalanced.push(`${f} (BEGIN ${begins} / COMMIT ${commits})`);
    }
    expect(unbalanced).toEqual([]);
  });

  it("version prefixes are 14-digit timestamps", () => {
    for (const f of files) expect(versionOf(f), f).toMatch(/^\d{14}$/);
  });

  it("no NEW duplicate version numbers (the ledger is keyed by version, so twins hide each other's failure)", () => {
    const byVersion = new Map<string, string[]>();
    for (const f of files) byVersion.set(versionOf(f), [...(byVersion.get(versionOf(f)) ?? []), f]);
    const duplicates = [...byVersion.entries()].filter(([, fs]) => fs.length > 1).map(([v]) => v);
    const unexpected = duplicates.filter((v) => !KNOWN_DUPLICATE_VERSIONS.has(v));
    expect(unexpected, "rename one file of each pair to a unique version (see scripts/dev-seed/README.md)").toEqual([]);
  });
});

describe.skipIf(!hasDatabase)("migration ledger vs. the connected database", () => {
  it("every migration on disk is recorded, except the known non-replayable set", async () => {
    const c = await pgClient();
    try {
      const recorded = new Set((await c.query("SELECT version FROM supabase_migrations.schema_migrations")).rows.map((r: { version: string }) => r.version));
      const missing = files.map(versionOf).filter((v) => !recorded.has(v));
      const unexpected = [...new Set(missing)].filter((v) => !KNOWN_NON_REPLAYABLE.has(v));
      const allowlisted = [...new Set(missing)].filter((v) => KNOWN_NON_REPLAYABLE.has(v));
      if (allowlisted.length) console.info(`not applied here, as expected on a fresh database: ${allowlisted.join(", ")}`);
      expect(unexpected).toEqual([]);
    } finally {
      await c.end();
    }
  });
});
