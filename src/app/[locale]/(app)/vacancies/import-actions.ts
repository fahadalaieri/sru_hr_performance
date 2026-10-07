"use server";

import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { VACANCY_IMPORT_COLUMNS } from "@/lib/importColumns";
import { applyMapping, parseImportOptions, updatesExisting, writesField } from "@/lib/excelImportOptions";
import { cellText, headerMap, loadImportWorkbook } from "@/lib/excelImport";

export type VacanciesImportResult =
  | {
      status: "success";
      summary: {
        created: number;
        updated: number;
        rowErrors: string[];
      };
    }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "unknown" };

const COL_JOB_TITLE = "المسمى الوظيفي";
const COL_ORG_UNIT = "الوحدة التنظيمية";
const COL_JOB_FAMILY = "العائلة الوظيفية";
const COL_STATUS = "الحالة";
const COL_REQUIREMENTS = "المتطلبات";

const REQUIRED_COLUMNS = [COL_JOB_TITLE, COL_ORG_UNIT];

/**
 * Bulk import for `vacancies` — one sheet, one row per vacancy (job title +
 * org unit, plus optional status/requirements). Mirrors the career-path and
 * job-titles imports' established shape: exact-name matching against the real
 * reference tables, per-row errors collected rather than aborting the whole
 * import, and every write through the caller's own RLS-respecting client —
 * real authorization is `vacancies_insert`'s `check_vpra('vacancies',
 * 'approve', org_unit_id)` (hr_admin-only per the seeded matrix) and
 * `vacancies_update`'s `'recommend'` bar (20260719000007), not this code.
 *
 * Job titles are matched by exact trimmed `name_ar`. `job_titles.name_ar` is
 * only unique per family (UNIQUE (job_family_id, name_ar)) — 4 of the 359 real
 * rows genuinely share a name across two families — so an optional
 * "العائلة الوظيفية" column disambiguates those; a name that still matches
 * more than one row is skipped with an explicit error rather than guessed at,
 * same conservative discipline as the career-path import. `org_units.name_ar`
 * has no uniqueness constraint either, but all 58 real rows are distinct
 * today — the same ambiguity check is applied anyway rather than assuming
 * that stays true.
 *
 * [استنتاج] Idempotency key: `vacancies` has NO unique constraint at all
 * (unlike `career_path`'s UNIQUE(from,to) or `job_titles`' UNIQUE(family,
 * name)), so re-importing the same file would otherwise silently duplicate
 * every row. (job_title_id, org_unit_id) among non-deleted rows is treated as
 * the natural key — one open posting per job title per org unit — so a
 * re-import updates the existing posting's status/requirements in place. This
 * is an inferred rule, not a documented one: an organization wanting two
 * simultaneous postings for the same title in the same unit can't express
 * that through this import.
 */
export async function importVacanciesExcel(
  _prevState: VacanciesImportResult | null,
  formData: FormData
): Promise<VacanciesImportResult> {
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
    workbook.worksheets.find((w) => w.name.trim() === "الشواغر") ??
    workbook.worksheets.find((w) => /شاغر|شواغر/.test(w.name)) ??
    workbook.worksheets[0];
  if (!sheet) {
    return { status: "error", message: "invalid_input" };
  }

  const options = parseImportOptions(formData);
  const cols = applyMapping(headerMap(sheet), options, VACANCY_IMPORT_COLUMNS);
  if (REQUIRED_COLUMNS.some((name) => !cols.has(name))) {
    return { status: "error", message: "invalid_input" };
  }

  const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);

  interface ParsedRow {
    rowNumber: number;
    jobTitleNameAr: string;
    jobFamilyNameAr: string | null;
    orgUnitNameAr: string;
    status: string | null;
    requirementsAr: string | null;
  }

  const parsedRows: ParsedRow[] = [];
  const rowErrors: string[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const jobTitleNameAr = cellText(get(row, COL_JOB_TITLE));
    const orgUnitNameAr = cellText(get(row, COL_ORG_UNIT));
    if (!jobTitleNameAr && !orgUnitNameAr) continue;

    if (!jobTitleNameAr || !orgUnitNameAr) {
      rowErrors.push(`الصف ${r}: بيانات مطلوبة ناقصة (المسمى الوظيفي/الوحدة التنظيمية) — تم التجاوز`);
      continue;
    }

    parsedRows.push({
      rowNumber: r,
      jobTitleNameAr,
      jobFamilyNameAr: cellText(get(row, COL_JOB_FAMILY)),
      orgUnitNameAr,
      status: cellText(get(row, COL_STATUS)),
      requirementsAr: cellText(get(row, COL_REQUIREMENTS)),
    });
  }

  // Reference data, read through the caller's own client — a job title or org
  // unit the caller cannot see simply won't resolve, surfacing as a per-row
  // "not found" instead of a silent cross-scope write.
  const [{ data: jobTitlesData }, { data: jobFamiliesData }, { data: orgUnitsData }] = await Promise.all([
    supabase.from("job_titles").select("id, name_ar, job_family_id").is("deleted_at", null),
    // `job_families` has no `deleted_at` column (20260716000012); `org_units`
    // does, but the create-vacancy screen's own org-unit list doesn't filter
    // on it either — matched here so the import can resolve exactly the same
    // set of units the form offers.
    supabase.from("job_families").select("id, name_ar"),
    supabase.from("org_units").select("id, name_ar"),
  ]);

  const familyNameById = new Map((jobFamiliesData ?? []).map((f) => [f.id, f.name_ar]));

  const jobTitlesByName = new Map<string, { id: string; familyNameAr: string | null }[]>();
  for (const jt of jobTitlesData ?? []) {
    const list = jobTitlesByName.get(jt.name_ar) ?? [];
    list.push({ id: jt.id, familyNameAr: familyNameById.get(jt.job_family_id) ?? null });
    jobTitlesByName.set(jt.name_ar, list);
  }

  const orgUnitIdsByName = new Map<string, string[]>();
  for (const ou of orgUnitsData ?? []) {
    const list = orgUnitIdsByName.get(ou.name_ar) ?? [];
    list.push(ou.id);
    orgUnitIdsByName.set(ou.name_ar, list);
  }

  function resolveJobTitleId(row: ParsedRow): string | null {
    const matches = jobTitlesByName.get(row.jobTitleNameAr);
    if (!matches || matches.length === 0) {
      rowErrors.push(`الصف ${row.rowNumber}: المسمى الوظيفي "${row.jobTitleNameAr}" غير موجود — تم التجاوز`);
      return null;
    }
    const narrowed = row.jobFamilyNameAr
      ? matches.filter((m) => m.familyNameAr === row.jobFamilyNameAr)
      : matches;
    if (narrowed.length === 0) {
      rowErrors.push(
        `الصف ${row.rowNumber}: المسمى الوظيفي "${row.jobTitleNameAr}" غير موجود ضمن العائلة الوظيفية "${row.jobFamilyNameAr}" — تم التجاوز`
      );
      return null;
    }
    if (narrowed.length > 1) {
      rowErrors.push(
        `الصف ${row.rowNumber}: المسمى الوظيفي "${row.jobTitleNameAr}" غير فريد (موجود في أكثر من عائلة وظيفية) — حدّد العائلة الوظيفية — تم التجاوز`
      );
      return null;
    }
    return narrowed[0].id;
  }

  function resolveOrgUnitId(row: ParsedRow): string | null {
    const ids = orgUnitIdsByName.get(row.orgUnitNameAr);
    if (!ids || ids.length === 0) {
      rowErrors.push(`الصف ${row.rowNumber}: الوحدة التنظيمية "${row.orgUnitNameAr}" غير موجودة — تم التجاوز`);
      return null;
    }
    if (ids.length > 1) {
      rowErrors.push(`الصف ${row.rowNumber}: الوحدة التنظيمية "${row.orgUnitNameAr}" غير فريدة — تم التجاوز`);
      return null;
    }
    return ids[0];
  }

  const { data: existingData } = await supabase
    .from("vacancies")
    .select("id, job_title_id, org_unit_id")
    .is("deleted_at", null);
  const existingIdByPair = new Map((existingData ?? []).map((v) => [`${v.job_title_id}::${v.org_unit_id}`, v.id]));

  const toInsert: { job_title_id: string; org_unit_id: string; status: string; requirements_ar: string | null }[] = [];
  const toUpdate: { id: string; patch: { status?: string; requirements_ar?: string | null } }[] = [];
  const seenPairs = new Set<string>();

  for (const row of parsedRows) {
    const jobTitleId = resolveJobTitleId(row);
    const orgUnitId = resolveOrgUnitId(row);
    if (!jobTitleId || !orgUnitId) continue;

    const pair = `${jobTitleId}::${orgUnitId}`;
    if (seenPairs.has(pair)) {
      rowErrors.push(
        `الصف ${row.rowNumber} ("${row.jobTitleNameAr}" / "${row.orgUnitNameAr}"): مكرر داخل الملف نفسه — تم التجاوز`
      );
      continue;
    }
    seenPairs.add(pair);

    const status = row.status ?? "open";
    const existingId = existingIdByPair.get(pair);
    if (existingId) {
      // "Add new only" skips it entirely rather than silently rewriting a
      // live posting — the default, and what the dialog promises.
      if (updatesExisting(options)) {
        const patch: { status?: string; requirements_ar?: string | null } = {};
        if (writesField(options, "status")) patch.status = status;
        if (writesField(options, "requirements")) patch.requirements_ar = row.requirementsAr;
        // Every field deselected means there is nothing to write; updating
        // with {} would count a row as changed without changing it.
        if (Object.keys(patch).length > 0) toUpdate.push({ id: existingId, patch });
      }
    } else {
      toInsert.push({
        job_title_id: jobTitleId,
        org_unit_id: orgUnitId,
        // A deselected field is left at the column's default rather than
        // written from the file.
        status: writesField(options, "status") ? status : "open",
        requirements_ar: writesField(options, "requirements") ? row.requirementsAr : null,
      });
    }
  }

  let created = 0;
  let updated = 0;

  if (toInsert.length > 0) {
    const { data: inserted, error } = await supabase.from("vacancies").insert(toInsert).select("id");
    if (error) {
      rowErrors.push(`الإدراج: ${error.message}`);
    } else {
      created = inserted?.length ?? 0;
    }
  }

  for (const { id, patch } of toUpdate) {
    const { error } = await supabase.from("vacancies").update(patch).eq("id", id);
    if (error) {
      rowErrors.push(`تحديث الشاغر ${id}: ${error.message}`);
    } else {
      updated += 1;
    }
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "vacancies_excel_imported",
    entity: "vacancies",
    after_data: { created, updated, rowErrorCount: rowErrors.length, mode: options.mode },
  });

  return { status: "success", summary: { created, updated, rowErrors } };
}
