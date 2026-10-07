import fs from "node:fs";
import path from "node:path";

/**
 * Loads `.env.local` into process.env for the integration run (values already
 * present in the environment win, so CI secrets or a shell export override the
 * file). Refuses to run against anything that looks like the production
 * project: these tests create and delete real auth users.
 */
const file = path.join(process.cwd(), ".env.local");
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    if (!(key in process.env)) process.env[key] = line.slice(i + 1).trim();
  }
}

const PRODUCTION_REF = "rrzrrytrdhgmypxjfbmw"; // CLAUDE.md §2 — the owner's project
if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(PRODUCTION_REF) || (process.env.DATABASE_URL ?? "").includes(PRODUCTION_REF)) {
  throw new Error("Integration tests refuse to run against the production Supabase project. Point .env.local at a development database.");
}
