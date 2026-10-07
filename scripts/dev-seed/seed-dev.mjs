#!/usr/bin/env node
/**
 * بذر بيئة تطوير على قاعدة فارغة — آمن للتكرار، يُنشئ فقط ما ليس موجودًا.
 *
 *   node scripts/dev-seed/seed-dev.mjs            ينفّذ
 *   node scripts/dev-seed/seed-dev.mjs --dry-run  يُظهر ما سيُنشأ داخل معاملة تُلغى (بلا حساب Auth)
 *
 * ما يُبذر ولماذا: scripts/dev-seed/README.md. القاعدة: كل صف إمّا مشتق من
 * بيانات مرجعية حقيقية تحملها الهجرات (org_units, job_titles) أو قيمة اختبارية
 * باسم يصرّح بذلك. لا راتب ولا جدارة ولا موظف يُختلق.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const { Client } = require(path.join(root, "node_modules", "pg"));
const { createClient } = require(path.join(root, "node_modules", "@supabase", "supabase-js"));

const PRODUCTION_REF = "rrzrrytrdhgmypxjfbmw";
export const DEV_ADMIN_EMPLOYEE_NUMBER = "DEV-0001";
export const DEV_ADMIN_USERNAME = "admin";
const LEVEL_DEPTH = 4;

export function loadEnv() {
  const file = path.join(root, ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      const key = line.slice(0, i).trim();
      if (!(key in process.env)) process.env[key] = line.slice(i + 1).trim();
    }
  }
  for (const k of ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[k]) throw new Error(`${k} غير مضبوط في .env.local`);
  }
  if (process.env.DATABASE_URL.includes(PRODUCTION_REF) || process.env.NEXT_PUBLIC_SUPABASE_URL.includes(PRODUCTION_REF)) {
    throw new Error("هذا البذر لقواعد التطوير فقط؛ البيئة تشير إلى مشروع الإنتاج");
  }
}

const log = (msg) => console.log(`  ${msg}`);

/** حساب المشرف التطويري: ملف + دور معلّق؛ حساب Auth يُنشأ في commitAdminAuthUser بعد الالتزام. */
export async function seedAdminProfile(c) {
  const existing = await c.query("SELECT id, auth_user_id FROM profiles WHERE employee_number=$1 OR username=$2 LIMIT 1", [DEV_ADMIN_EMPLOYEE_NUMBER, DEV_ADMIN_USERNAME]);
  if (existing.rows.length) { log(`المشرف التطويري موجود (${existing.rows[0].auth_user_id ? "مرتبط بحساب" : "بلا حساب Auth بعد"}) — تخطّي`); return { created: false, profileId: existing.rows[0].id, linked: Boolean(existing.rows[0].auth_user_id) }; }
  const email = (process.env.DEV_ADMIN_EMAIL ?? "").toLowerCase();
  if (!email) { log("DEV_ADMIN_EMAIL غير مضبوط — تخطّي إنشاء المشرف"); return { created: false, profileId: null, linked: false }; }
  const role = (await c.query("SELECT id FROM roles WHERE role_code='super_admin'")).rows[0];
  if (!role) throw new Error("دور super_admin غير موجود — طبّق الهجرات أولًا");
  const p = (await c.query(
    "INSERT INTO profiles(employee_number, full_name_ar, full_name_en, email, username, status, approval_status) VALUES ($1,'مشرف التطوير','Dev Admin',$2,$3,'active','approved') RETURNING id",
    [DEV_ADMIN_EMPLOYEE_NUMBER, email, DEV_ADMIN_USERNAME]
  )).rows[0];
  await c.query("INSERT INTO pending_role_assignments(profile_id, role_id, scope_type) VALUES ($1,$2,'all')", [p.id, role.id]);
  log(`أُنشئ ملف المشرف التطويري ${DEV_ADMIN_EMPLOYEE_NUMBER} (${email}) مع دور super_admin معلّق`);
  return { created: true, profileId: p.id, linked: false };
}

/** يُنشئ حساب Auth فيلتقطه المحفّز link_profile_to_auth_user ويرقّي الدور المعلّق. لا يعمل في --dry-run. */
export async function commitAdminAuthUser(c) {
  const email = (process.env.DEV_ADMIN_EMAIL ?? "").toLowerCase();
  const password = process.env.DEV_ADMIN_PASSWORD;
  const row = (await c.query("SELECT id, auth_user_id FROM profiles WHERE employee_number=$1", [DEV_ADMIN_EMPLOYEE_NUMBER])).rows[0];
  if (!row || row.auth_user_id) return;
  if (!email || !password) { log("DEV_ADMIN_EMAIL/DEV_ADMIN_PASSWORD غير مضبوطين — الملف موجود بلا حساب Auth"); return; }
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`إنشاء حساب Auth فشل: ${error.message}`);
  const linked = (await c.query("SELECT auth_user_id FROM profiles WHERE id=$1", [row.id])).rows[0].auth_user_id;
  const roles = (await c.query("SELECT count(*)::int n FROM user_roles WHERE user_id=$1", [linked])).rows[0].n;
  log(`أُنشئ حساب Auth للمشرف وربطه المحفّز (${roles} دور)`);
}

export async function seedEvaluationCycle(c) {
  const n = (await c.query("SELECT count(*)::int n FROM evaluation_cycles WHERE deleted_at IS NULL")).rows[0].n;
  if (n > 0) { log(`دورات التقييم موجودة (${n}) — تخطّي`); return { created: false }; }
  const year = new Date().getFullYear();
  await c.query("INSERT INTO evaluation_cycles(name_ar, name_en, start_date, end_date, cycle_type) VALUES ($1,$2,$3,$4,'calendar')", [`دورة التطوير ${year}`, `Dev cycle ${year}`, `${year}-01-01`, `${year}-12-31`]);
  log(`أُنشئت دورة التقييم «دورة التطوير ${year}» (calendar)`);
  return { created: true };
}

/**
 * مستويات الهيكل الأربعة ومنصب لكل وحدة تنظيمية حتى العمق الرابع من جذر
 * org_units — مشتق بالكامل من الشجرة الحقيقية التي تحملها الهجرات.
 */
export async function seedOrgStructure(c) {
  const levels = (await c.query("SELECT count(*)::int n FROM org_structure_levels WHERE deleted_at IS NULL")).rows[0].n;
  const positions = (await c.query("SELECT count(*)::int n FROM org_structure_positions WHERE deleted_at IS NULL")).rows[0].n;
  if (levels > 0 || positions > 0) { log(`الهيكل التنظيمي غير فارغ (${levels} مستوى، ${positions} منصب) — تخطّي`); return { levels: 0, positions: 0 }; }
  const levelIds = [];
  for (let i = 1; i <= LEVEL_DEPTH; i++) {
    levelIds.push((await c.query("INSERT INTO org_structure_levels(name_ar, name_en, level_order) VALUES ($1,$2,$3) RETURNING id", [`المستوى ${i}`, `Level ${i}`, i])).rows[0].id);
  }
  const units = (await c.query("SELECT id, name_ar, name_en, parent_id FROM org_units WHERE deleted_at IS NULL")).rows;
  const byParent = new Map();
  for (const u of units) { const k = u.parent_id ?? "root"; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(u); }
  let created = 0;
  const queue = (byParent.get("root") ?? []).map((u) => ({ unit: u, depth: 1, parentPositionId: null }));
  while (queue.length) {
    const { unit, depth, parentPositionId } = queue.shift();
    if (depth > LEVEL_DEPTH) continue;
    const pos = (await c.query(
      "INSERT INTO org_structure_positions(level_id, parent_id, name_ar, name_en, org_unit_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [levelIds[depth - 1], parentPositionId, unit.name_ar, unit.name_en, unit.id]
    )).rows[0].id;
    created++;
    for (const child of byParent.get(unit.id) ?? []) queue.push({ unit: child, depth: depth + 1, parentPositionId: pos });
  }
  log(`أُنشئت ${LEVEL_DEPTH} مستويات و${created} منصبًا مشتقًا من org_units (حتى العمق ${LEVEL_DEPTH})`);
  return { levels: LEVEL_DEPTH, positions: created };
}

/** سلّم عائلة «عام»: الدرجة N → N+1 حين تحمل كل درجة مسمًى واحدًا؛ الدرجات الغامضة تُتخطّى وتُذكر. */
export async function seedGenericCareerLadder(c) {
  const rows = (await c.query(
    "SELECT jt.id, jt.grade_level FROM job_titles jt JOIN job_families jf ON jf.id = jt.job_family_id WHERE jf.name_ar='عام' AND jt.deleted_at IS NULL ORDER BY jt.grade_level"
  )).rows;
  if (!rows.length) { log("عائلة «عام» غير موجودة في job_titles — تخطّي السلّم"); return { created: 0, skippedGrades: [] }; }
  const byGrade = new Map();
  for (const r of rows) { if (!byGrade.has(r.grade_level)) byGrade.set(r.grade_level, []); byGrade.get(r.grade_level).push(r.id); }
  const grades = [...byGrade.keys()].sort((a, b) => a - b);
  let created = 0; const skippedGrades = [];
  for (let i = 0; i < grades.length - 1; i++) {
    const from = byGrade.get(grades[i]), to = byGrade.get(grades[i + 1]);
    if (from.length !== 1 || to.length !== 1) { skippedGrades.push(`${grades[i]}→${grades[i + 1]}`); continue; }
    const exists = (await c.query("SELECT 1 FROM career_path WHERE from_job_title_id=$1 AND to_job_title_id=$2", [from[0], to[0]])).rows.length;
    if (exists) continue;
    await c.query("INSERT INTO career_path(from_job_title_id, to_job_title_id) VALUES ($1,$2)", [from[0], to[0]]);
    created++;
  }
  log(`سلّم «عام»: ${created} رابطًا جديدًا${skippedGrades.length ? `؛ تُخُطِّيت درجات غامضة (أكثر من مسمًى): ${skippedGrades.join(", ")}` : ""}`);
  return { created, skippedGrades };
}

export async function runSeed({ dryRun }) {
  loadEnv();
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    console.log(dryRun ? "تجربة جافة — كل شيء داخل معاملة تُلغى:" : "بذر بيئة التطوير:");
    await c.query("BEGIN");
    await seedAdminProfile(c);
    await seedEvaluationCycle(c);
    await seedOrgStructure(c);
    await seedGenericCareerLadder(c);
    await c.query(dryRun ? "ROLLBACK" : "COMMIT");
    if (dryRun) log("أُلغيت المعاملة — لم يتغيّر شيء");
    else await commitAdminAuthUser(c);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSeed({ dryRun: process.argv.includes("--dry-run") }).catch((e) => { console.error(e.message); process.exit(1); });
}
