"use server";

import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { JOB_TITLE_IMPORT_COLUMNS } from "@/lib/importColumns";
import { applyMapping, parseImportOptions, updatesExisting, writesField } from "@/lib/excelImportOptions";
import { computeAutoApplyClassificationIds } from "@/lib/competencyFramework";
import { cellText, headerMap, loadImportWorkbook } from "@/lib/excelImport";

export type JobTitlesImportResult =
  | {
      status: "success";
      summary: {
        created: number;
        updated: number;
        competenciesSet: number;
        rowErrors: string[];
      };
    }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "unknown" };

const CATEGORY_LABELS: Record<string, "leadership" | "academic" | "admin" | "technical" | "labor"> = {
  "قيادية": "leadership",
  "أكاديمية": "academic",
  "إدارية": "admin",
  "تقنية": "technical",
  "عمالية": "labor",
  leadership: "leadership",
  academic: "academic",
  admin: "admin",
  technical: "technical",
  labor: "labor",
};

const LEVEL_LABELS: Record<string, "basic" | "practitioner" | "advanced" | "professional"> = {
  "أساسي": "basic",
  "ممارس": "practitioner",
  "متقدم": "advanced",
  "محترف": "professional",
  basic: "basic",
  practitioner: "practitioner",
  advanced: "advanced",
  professional: "professional",
};

function requireColumns(map: Map<string, number>, names: string[]): string | null {
  for (const name of names) {
    if (!map.has(name)) return name;
  }
  return null;
}

const REQUIRED_COLUMNS = ["اسم المسمى الوظيفي", "العائلة الوظيفية", "الدرجة", "الفئة"];

const BATCH_SIZE = 50;

/**
 * Bulk import for `job_titles` — one sheet, one row per job title. Column
 * set mirrors the fields `CreateJobTitleForm`/`JobTitleCoreForm` already
 * expose (name_ar/name_en/family/grade/category/qualification/description),
 * plus (2026-08-04 follow-up, per direct feedback that the first version
 * "لم يتطرق الى الجدارات" — didn't address competencies) one OPTIONAL extra
 * column per real INSTITUTIONAL (classification.auto_apply_everywhere=true,
 * was hardcoded to type='core' before 20260829000001) competency, named
 * after that competency's own name_ar, holding a required_level label
 * (أساسي/ممارس/متقدم/محترف). Deliberately scoped to auto-applying
 * competencies only, not others — the same 11 apply to every job title (matching
 * `JobTitleCompetenciesManager`'s own core-vs-specialized split), so a fixed
 * column set works, whereas specialized competencies vary per pillar/domain
 * and would need a fundamentally different sheet shape (e.g. one row per
 * job-title+competency pair) that wasn't asked for here. `career_path`
 * edges still stay out of scope, same reasoning as before (no clean flat
 * representation without a dedicated edge-shaped sheet, already served by
 * the separate career_path import).
 *
 * A blank competency cell is skipped entirely (an existing assignment is
 * left untouched, not cleared) — this import only ever adds or updates a
 * level, never removes one, matching org_structure_assignments' own
 * "add/update only" import discipline.
 *
 * Every write goes through the caller's own RLS-respecting client, exactly
 * like importOrgStructureExcel — real authorization is job_titles_insert/
 * update's own `careerPath>=prepare` RLS (job_title_competencies_insert/
 * update share the identical bar), not this action's code. A row that RLS
 * rejects surfaces as a per-row error in the summary rather than aborting
 * the whole import, same discipline as every other bulk-error collection in
 * this app.
 *
 * job_titles has a PLAIN `UNIQUE(job_family_id, name_ar)` (not a partial
 * index, unlike org_structure_positions.external_code/evaluation_scores/
 * calibration_results), so this doesn't need the select-then-insert-or-update
 * workaround purely to dodge an ON CONFLICT limitation — but selecting
 * existing rows first is still needed to (a) know create-vs-update counts,
 * and (b) reset career_content_status to 'draft' on an update, mirroring
 * updateJobTitleCore's own behavior for any manual edit.
 * `job_title_competencies` DOES have a partial unique index
 * (`(job_title_id, competency_id) WHERE deleted_at IS NULL`), so its own
 * assignment pass uses the same select-then-insert-or-update workaround
 * already established for evaluation_scores/calibration_results.
 */
export async function importJobTitlesExcel(
  _prevState: JobTitlesImportResult | null,
  formData: FormData
): Promise<JobTitlesImportResult> {
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
    workbook.worksheets.find((w) => w.name.trim() === "المسميات الوظيفية") ??
    workbook.worksheets.find((w) => /مسميات|وظيف/.test(w.name)) ??
    workbook.worksheets[0];
  if (!sheet) {
    return { status: "error", message: "invalid_input" };
  }

  const options = parseImportOptions(formData);
  const cols = applyMapping(headerMap(sheet), options, JOB_TITLE_IMPORT_COLUMNS);
  const missingColumn = requireColumns(cols, REQUIRED_COLUMNS);
  if (missingColumn) {
    return { status: "error", message: "invalid_input" };
  }

  const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);

  // Core competencies whose columns (if present in the sheet) carry a
  // required_level per job title — see the function-level doc comment.
  // "Core" is now whichever classification(s) are flagged
  // auto_apply_everywhere (20260829000001), not a hardcoded 'core' string.
  const { data: classificationsData } = await supabase.from("competency_classifications").select("id, name_ar, name_en, auto_apply_everywhere");
  const autoApplyClassificationIds = computeAutoApplyClassificationIds(
    (classificationsData as Array<{ id: string; name_ar: string; name_en: string | null; auto_apply_everywhere: boolean }>) ?? []
  );
  const { data: coreCompetenciesData } = await supabase
    .from("competencies")
    .select("id, name_ar, classification_id")
    .is("deleted_at", null);
  const coreCompetencyColumns = ((coreCompetenciesData ?? []) as Array<{ id: string; name_ar: string; classification_id: string }>).filter(
    (c) => autoApplyClassificationIds.has(c.classification_id) && cols.has(c.name_ar)
  );

  interface ParsedRow {
    rowNumber: number;
    nameAr: string;
    nameEn: string | null;
    familyNameAr: string;
    gradeLevel: number;
    category: "leadership" | "academic" | "admin" | "technical" | "labor";
    qualificationRequired: string | null;
    descriptionAr: string | null;
    competencyLevels: Array<{ competencyId: string; competencyNameAr: string; levelText: string }>;
  }

  const parsedRows: ParsedRow[] = [];
  const rowErrors: string[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const nameAr = cellText(get(row, "اسم المسمى الوظيفي"));
    if (!nameAr) continue;

    const familyNameAr = cellText(get(row, "العائلة الوظيفية"));
    const gradeText = cellText(get(row, "الدرجة"));
    const categoryText = cellText(get(row, "الفئة"));

    if (!familyNameAr || !gradeText || !categoryText) {
      rowErrors.push(`الصف ${r} ("${nameAr}"): بيانات مطلوبة ناقصة — تم التجاوز`);
      continue;
    }

    const gradeLevel = parseInt(gradeText, 10);
    if (!Number.isInteger(gradeLevel) || gradeLevel < 1 || gradeLevel > 16) {
      rowErrors.push(`الصف ${r} ("${nameAr}"): درجة غير صالحة "${gradeText}" — تم التجاوز`);
      continue;
    }

    const category = CATEGORY_LABELS[categoryText.trim()];
    if (!category) {
      rowErrors.push(`الصف ${r} ("${nameAr}"): فئة غير معروفة "${categoryText}" — تم التجاوز`);
      continue;
    }

    const competencyLevels: ParsedRow["competencyLevels"] = [];
    for (const c of coreCompetencyColumns) {
      const levelText = cellText(get(row, c.name_ar));
      if (levelText) competencyLevels.push({ competencyId: c.id, competencyNameAr: c.name_ar, levelText });
    }

    parsedRows.push({
      rowNumber: r,
      nameAr,
      nameEn: cellText(get(row, "الاسم بالإنجليزية")),
      familyNameAr,
      gradeLevel,
      category,
      qualificationRequired: cellText(get(row, "المؤهل المطلوب")),
      descriptionAr: cellText(get(row, "الوصف الوظيفي")),
      competencyLevels,
    });
  }

  const { data: familiesData } = await supabase.from("job_families").select("id, name_ar");
  const familyIdByName = new Map((familiesData ?? []).map((f) => [f.name_ar.trim(), f.id]));

  const { data: existingTitlesData } = await supabase
    .from("job_titles")
    .select("id, job_family_id, name_ar")
    .is("deleted_at", null);
  const existingIdByKey = new Map((existingTitlesData ?? []).map((t) => [`${t.job_family_id}::${t.name_ar}`, t.id]));

  const toInsert: {
    job_family_id: string;
    name_ar: string;
    name_en: string | null;
    grade_level: number;
    category: string;
    qualification_required: string | null;
    description_ar: string | null;
  }[] = [];
  const toUpdate: { id: string; row: ParsedRow }[] = [];

  for (const row of parsedRows) {
    const familyId = familyIdByName.get(row.familyNameAr.trim());
    if (!familyId) {
      rowErrors.push(`الصف ${row.rowNumber} ("${row.nameAr}"): العائلة الوظيفية "${row.familyNameAr}" غير موجودة — تم التجاوز`);
      continue;
    }
    const existingId = existingIdByKey.get(`${familyId}::${row.nameAr}`);
    if (existingId) {
      toUpdate.push({ id: existingId, row });
    } else {
      toInsert.push({
        job_family_id: familyId,
        name_ar: row.nameAr,
        name_en: row.nameEn,
        grade_level: row.gradeLevel,
        category: row.category,
        qualification_required: row.qualificationRequired,
        description_ar: row.descriptionAr,
      });
    }
  }

  let created = 0;
  let updated = 0;

  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const { data: inserted, error } = await supabase.from("job_titles").insert(batch).select("id");
    if (error) {
      rowErrors.push(`دفعة الإدراج ${i / BATCH_SIZE + 1}: ${error.message}`);
    } else {
      created += inserted?.length ?? 0;
    }
  }

  for (const { id, row } of toUpdate) {
    // "Add new only" leaves an existing title exactly as it is.
    if (!updatesExisting(options)) break;

    const patch: Record<string, unknown> = {};
    if (writesField(options, "nameEn")) patch.name_en = row.nameEn;
    if (writesField(options, "gradeLevel")) patch.grade_level = row.gradeLevel;
    if (writesField(options, "category")) patch.category = row.category;
    if (writesField(options, "qualification")) patch.qualification_required = row.qualificationRequired;
    if (writesField(options, "description")) patch.description_ar = row.descriptionAr;
    // Nothing ticked means nothing to write; an empty update would still be
    // counted as a changed row.
    if (Object.keys(patch).length === 0) continue;
    // Content changed, so the approval it may already carry no longer applies.
    patch.career_content_status = "draft";

    const { error } = await supabase.from("job_titles").update(patch).eq("id", id);
    if (error) {
      rowErrors.push(`الصف ${row.rowNumber} ("${row.nameAr}"): ${error.message}`);
    } else {
      updated += 1;
    }
  }

  // Competency assignment pass — re-fetch job_titles by (family, name) AFTER
  // the insert/update above, since a batch INSERT's returned row order isn't
  // safe to match back against `toInsert` one-to-one.
  let competenciesSet = 0;
  const rowsNeedingCompetencies = parsedRows.filter((r) => r.competencyLevels.length > 0);
  if (rowsNeedingCompetencies.length > 0) {
    const { data: refreshedTitles } = await supabase
      .from("job_titles")
      .select("id, job_family_id, name_ar")
      .is("deleted_at", null);
    const idByKeyAfter = new Map((refreshedTitles ?? []).map((t) => [`${t.job_family_id}::${t.name_ar}`, t.id]));

    const resolvedJobTitleIds: string[] = [];
    const assignments: { jobTitleId: string; competencyId: string; requiredLevel: string; rowNumber: number; competencyNameAr: string }[] =
      [];
    for (const row of rowsNeedingCompetencies) {
      const familyId = familyIdByName.get(row.familyNameAr.trim());
      const jobTitleId = familyId ? idByKeyAfter.get(`${familyId}::${row.nameAr}`) : undefined;
      if (!jobTitleId) continue; // the job_titles row itself already failed and was reported above
      resolvedJobTitleIds.push(jobTitleId);
      for (const c of row.competencyLevels) {
        const level = LEVEL_LABELS[c.levelText.trim()];
        if (!level) {
          rowErrors.push(
            `الصف ${row.rowNumber} ("${row.nameAr}"): مستوى غير معروف "${c.levelText}" لجدارة "${c.competencyNameAr}" — تم تجاوز هذه الجدارة`
          );
          continue;
        }
        assignments.push({ jobTitleId, competencyId: c.competencyId, requiredLevel: level, rowNumber: row.rowNumber, competencyNameAr: c.competencyNameAr });
      }
    }

    if (assignments.length > 0) {
      const { data: existingJtc } = await supabase
        .from("job_title_competencies")
        .select("id, job_title_id, competency_id")
        .is("deleted_at", null)
        .in("job_title_id", [...new Set(resolvedJobTitleIds)]);
      const existingIdByPair = new Map((existingJtc ?? []).map((x) => [`${x.job_title_id}::${x.competency_id}`, x.id]));

      const toInsertJtc: { job_title_id: string; competency_id: string; required_level: string }[] = [];
      for (const a of assignments) {
        const existingId = existingIdByPair.get(`${a.jobTitleId}::${a.competencyId}`);
        if (existingId) {
          const { error } = await supabase
            .from("job_title_competencies")
            .update({ required_level: a.requiredLevel })
            .eq("id", existingId);
          if (error) {
            rowErrors.push(`الصف ${a.rowNumber} ("${a.competencyNameAr}"): ${error.message}`);
          } else {
            competenciesSet += 1;
          }
        } else {
          toInsertJtc.push({ job_title_id: a.jobTitleId, competency_id: a.competencyId, required_level: a.requiredLevel });
        }
      }

      if (toInsertJtc.length > 0) {
        const { data: insertedJtc, error } = await supabase.from("job_title_competencies").insert(toInsertJtc).select("id");
        if (error) {
          rowErrors.push(`إدراج الجدارات: ${error.message}`);
        } else {
          competenciesSet += insertedJtc?.length ?? 0;
        }
      }
    }
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "job_titles_excel_imported",
    entity: "job_titles",
    after_data: { created, updated, competenciesSet, rowErrorCount: rowErrors.length },
  });

  return { status: "success", summary: { created, updated, competenciesSet, rowErrors } };
}
