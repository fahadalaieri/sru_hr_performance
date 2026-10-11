"use server";

import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CAREER_PATH_IMPORT_COLUMNS } from "@/lib/importColumns";
import { applyMapping, parseImportOptions, updatesExisting, writesField } from "@/lib/excelImportOptions";
import { cellText, headerMap, loadImportWorkbook } from "@/lib/excelImport";

export type CareerPathImportResult =
  | {
      status: "success";
      summary: {
        created: number;
        updated: number;
        rowErrors: string[];
      };
    }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "unknown" };

function requireColumns(map: Map<string, number>, names: string[]): string | null {
  for (const name of names) {
    if (!map.has(name)) return name;
  }
  return null;
}

const REQUIRED_COLUMNS = ["من (المسمى الوظيفي)", "إلى (المسمى الوظيفي)"];

/**
 * Bulk import for `career_path` — one sheet, one row per promotion edge
 * (from job title -> to job title, plus optional requirements text). Job
 * titles are matched by EXACT trimmed name_ar against the real `job_titles`
 * table — `job_titles.name_ar` is only unique per job family (UNIQUE
 * (job_family_id, name_ar)), so a name matching more than one real row is
 * treated as ambiguous and skipped with an explicit error rather than
 * guessing which family the sheet meant, same conservative discipline as
 * the job_titles import's family-name matching.
 *
 * `career_path` has a PLAIN `UNIQUE(from_job_title_id, to_job_title_id)`
 * (not partial), so this doesn't strictly need the select-then-insert-or-
 * update workaround purely to dodge an ON CONFLICT limitation — but
 * selecting existing edges first is still needed to report accurate
 * create-vs-update counts and to update `requirements_ar` on a re-import
 * without creating a duplicate row. The DB's own `CHECK
 * (from_job_title_id <> to_job_title_id)` is the real guard against a
 * self-referencing edge — any row that violates it surfaces as a normal
 * per-row error, not a crash.
 *
 * Every write goes through the caller's own RLS-respecting client — real
 * authorization is `career_path_insert`/`update`'s own `careerPath>=prepare`
 * RLS (20260719000011), not this action's code.
 */
export async function importCareerPathExcel(
  _prevState: CareerPathImportResult | null,
  formData: FormData
): Promise<CareerPathImportResult> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "invalid_input" };
  }

  const supabase = await createClient();
  const {
    data: { user: actor },
  } = await supabase.auth.getUser();
  if (!actor) {
    return { status: "error", message: "unauthenticated" };
  }

  // Size and row limits are enforced here, not only in the preview dialog
  // (src/lib/excelImport.ts). A limit the import itself does not check is
  // no limit, since this action can be called directly with any file.
  const loaded = await loadImportWorkbook(file);
  if (!loaded.ok) return { status: "error", message: "invalid_input" };
  const workbook = loaded.workbook;

  const sheet =
    workbook.worksheets.find((w) => w.name.trim() === "المسار الوظيفي") ??
    workbook.worksheets.find((w) => /مسار/.test(w.name)) ??
    workbook.worksheets[0];
  if (!sheet) {
    return { status: "error", message: "invalid_input" };
  }

  const options = parseImportOptions(formData);
  const cols = applyMapping(headerMap(sheet), options, CAREER_PATH_IMPORT_COLUMNS);
  const missingColumn = requireColumns(cols, REQUIRED_COLUMNS);
  if (missingColumn) {
    return { status: "error", message: "invalid_input" };
  }

  const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);

  interface ParsedRow {
    rowNumber: number;
    fromNameAr: string;
    toNameAr: string;
    requirementsAr: string | null;
  }

  const parsedRows: ParsedRow[] = [];
  const rowErrors: string[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const fromNameAr = cellText(get(row, "من (المسمى الوظيفي)"));
    const toNameAr = cellText(get(row, "إلى (المسمى الوظيفي)"));
    if (!fromNameAr && !toNameAr) continue;

    if (!fromNameAr || !toNameAr) {
      rowErrors.push(`الصف ${r}: بيانات مطلوبة ناقصة (من/إلى) — تم التجاوز`);
      continue;
    }
    if (fromNameAr === toNameAr) {
      rowErrors.push(`الصف ${r} ("${fromNameAr}"): لا يمكن أن يكون المسمى الوظيفي نفسه من وإلى — تم التجاوز`);
      continue;
    }

    parsedRows.push({
      rowNumber: r,
      fromNameAr,
      toNameAr,
      requirementsAr: cellText(get(row, "المتطلبات")),
    });
  }

  const { data: jobTitlesData } = await supabase.from("job_titles").select("id, name_ar").is("deleted_at", null);
  const idsByName = new Map<string, string[]>();
  for (const jt of jobTitlesData ?? []) {
    const list = idsByName.get(jt.name_ar) ?? [];
    list.push(jt.id);
    idsByName.set(jt.name_ar, list);
  }

  function resolveJobTitleId(name: string, rowNumber: number): string | null {
    const ids = idsByName.get(name);
    if (!ids || ids.length === 0) {
      rowErrors.push(`الصف ${rowNumber}: المسمى الوظيفي "${name}" غير موجود — تم التجاوز`);
      return null;
    }
    if (ids.length > 1) {
      rowErrors.push(`الصف ${rowNumber}: المسمى الوظيفي "${name}" غير فريد (موجود في أكثر من عائلة وظيفية) — تم التجاوز`);
      return null;
    }
    return ids[0];
  }

  const { data: existingEdgesData } = await supabase
    .from("career_path")
    .select("id, from_job_title_id, to_job_title_id")
    .is("deleted_at", null);
  const existingIdByPair = new Map((existingEdgesData ?? []).map((e) => [`${e.from_job_title_id}::${e.to_job_title_id}`, e.id]));

  const toInsert: { from_job_title_id: string; to_job_title_id: string; requirements_ar: string | null }[] = [];
  const toUpdate: { id: string; requirements_ar: string | null }[] = [];

  for (const row of parsedRows) {
    const fromId = resolveJobTitleId(row.fromNameAr, row.rowNumber);
    const toId = resolveJobTitleId(row.toNameAr, row.rowNumber);
    if (!fromId || !toId) continue;

    const existingId = existingIdByPair.get(`${fromId}::${toId}`);
    if (existingId) {
      toUpdate.push({ id: existingId, requirements_ar: row.requirementsAr });
    } else {
      toInsert.push({ from_job_title_id: fromId, to_job_title_id: toId, requirements_ar: row.requirementsAr });
    }
  }

  let created = 0;
  let updated = 0;

  if (toInsert.length > 0) {
    const { data: inserted, error } = await supabase.from("career_path").insert(toInsert).select("id");
    if (error) {
      rowErrors.push(`الإدراج: ${error.message}`);
    } else {
      created = inserted?.length ?? 0;
    }
  }

  for (const { id, requirements_ar } of toUpdate) {
    // "Add new only" leaves an existing edge's requirements untouched.
    if (!updatesExisting(options) || !writesField(options, "requirements")) continue;
    const { error } = await supabase.from("career_path").update({ requirements_ar }).eq("id", id);
    if (error) {
      rowErrors.push(`تحديث الصف ${id}: ${error.message}`);
    } else {
      updated += 1;
    }
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "career_path_excel_imported",
    entity: "career_path",
    after_data: { created, updated, rowErrorCount: rowErrors.length },
  });

  return { status: "success", summary: { created, updated, rowErrors } };
}
