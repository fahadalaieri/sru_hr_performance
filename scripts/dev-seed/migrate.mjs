#!/usr/bin/env node
/**
 * مشغّل هجرات بسيط لقاعدة تطوير (بديل عن Supabase CLI حين لا يكون متاحًا).
 *
 *   node scripts/dev-seed/migrate.mjs status          ما المُطبَّق وما الناقص
 *   node scripts/dev-seed/migrate.mjs apply           يطبّق الناقص بالترتيب ويتوقف عند أول فشل
 *   node scripts/dev-seed/migrate.mjs apply-continue  يطبّق الناقص ويتخطّى ما يفشل (يُلغي معاملته) ويُبلّغ
 *
 * - يقرأ DATABASE_URL من .env.local (أو من البيئة) ويرفض مشروع الإنتاج.
 * - يسجّل كل هجرة ناجحة في supabase_migrations.schema_migrations كما يفعل Supabase CLI.
 * - الملف الذي لا يفتح معاملة بنفسه يُغلَّف بـ BEGIN/COMMIT، فالفشل لا يترك نصف هجرة.
 * - الفشل في هجرة واردة في non-replayable.json متوقَّع ويُطبع كذلك؛ الفشل في غيرها يُطبع تحذيرًا صريحًا.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const { Client } = require(path.join(root, "node_modules", "pg"));

const PRODUCTION_REF = "rrzrrytrdhgmypxjfbmw";
const mode = process.argv[2] ?? "status";
if (!["status", "apply", "apply-continue"].includes(mode)) {
  console.error("usage: migrate.mjs status | apply | apply-continue");
  process.exit(2);
}

function loadEnv() {
  const file = path.join(root, ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      const key = line.slice(0, i).trim();
      if (!(key in process.env)) process.env[key] = line.slice(i + 1).trim();
    }
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL غير مضبوط (ضعه في .env.local — Session pooler)");
  if (process.env.DATABASE_URL.includes(PRODUCTION_REF)) throw new Error("هذا المشغّل لقواعد التطوير فقط؛ DATABASE_URL يشير إلى مشروع الإنتاج");
}

const nonReplayable = new Map(
  JSON.parse(fs.readFileSync(path.join(here, "non-replayable.json"), "utf8")).migrations.map((m) => [m.version, m.reason])
);

async function main() {
  loadEnv();
  const dir = path.join(root, "supabase", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query("CREATE SCHEMA IF NOT EXISTS supabase_migrations");
    await c.query("CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text)");
    const applied = new Set((await c.query("SELECT version FROM supabase_migrations.schema_migrations")).rows.map((r) => r.version));
    const pending = files.filter((f) => !applied.has(f.slice(0, 14)));

    // السجل يفتاح الإصدار لا الملف: ملفان بإصدار واحد يعني أن نجاح أحدهما
    // يُظهر الآخر مُطبَّقًا ولو فشل. نحذّر صراحةً بدل أن نكذب في العدّ.
    const byVersion = new Map();
    for (const f of files) byVersion.set(f.slice(0, 14), [...(byVersion.get(f.slice(0, 14)) ?? []), f]);
    const duplicates = [...byVersion.entries()].filter(([, fs]) => fs.length > 1);
    if (duplicates.length) {
      console.log(`تحذير: ${duplicates.length} إصدار يحمل أكثر من ملف — حالة «مُطبَّق» لهذه الإصدارات غير موثوقة:`);
      for (const [v, fs] of duplicates) console.log(`  ${v}: ${fs.map((f) => f.slice(15, -4)).join("  |  ")}`);
    }

    console.log(`ملفات: ${files.length} | مُطبَّق: ${files.length - pending.length} | ناقص: ${pending.length}`);
    if (mode === "status") {
      for (const f of pending) console.log(`  - ${f}${nonReplayable.has(f.slice(0, 14)) ? "   (معروف: لا يُعاد على قاعدة فارغة)" : ""}`);
      return;
    }

    const skipped = [];
    for (const f of pending) {
      const version = f.slice(0, 14);
      let sql = fs.readFileSync(path.join(dir, f), "utf8");
      const opensOwnTransaction = /^\s*BEGIN\s*;/im.test(sql);
      process.stdout.write(`→ ${f} ... `);
      try {
        if (!opensOwnTransaction) await c.query("BEGIN");
        await c.query(sql);
        if (!opensOwnTransaction) await c.query("COMMIT");
        await c.query("INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [version, f.slice(15, -4)]);
        console.log("تم");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        const expected = nonReplayable.has(version);
        console.log(expected ? `تخطّي (متوقَّع): ${firstLine(e.message)}` : `فشل: ${firstLine(e.message)}`);
        skipped.push({ f, expected });
        if (mode === "apply") process.exit(1);
      }
    }
    if (skipped.length) {
      console.log(`\nتُخُطِّي ${skipped.length}:`);
      for (const s of skipped) console.log(`  ${s.expected ? "·" : "!"} ${s.f}${s.expected ? "" : "   ← غير متوقَّع، راجع السبب"}`);
      if (skipped.some((s) => !s.expected)) process.exitCode = 1;
    }
  } finally {
    await c.end();
  }
}

const firstLine = (s) => String(s).split("\n")[0].slice(0, 160);
main().catch((e) => { console.error(e.message); process.exit(1); });
