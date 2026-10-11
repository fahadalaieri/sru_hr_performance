"use server";

import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { COMPETENCY_IMPORT_COLUMNS } from "@/lib/importColumns";
import { applyMapping, parseImportOptions, updatesExisting, writesField } from "@/lib/excelImportOptions";
import { behavioralLevelOrder, type BehavioralLevel } from "@/lib/competencyFramework";
import { cellText, headerMap, loadImportWorkbook } from "@/lib/excelImport";

export type CompetenciesImportResult =
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

const REQUIRED_COLUMNS = ["المحور", "المجال", "اسم الجدارة", "التصنيف"];

/**
 * Bulk import for `competencies` -- one sheet, one row per competency. Pillar
 * + domain together identify which `competency_domains` row a competency
 * belongs to (domain names are only unique per pillar, `UNIQUE(pillar_id,
 * name_ar)` -- requiring both columns disambiguates by construction, the
 * same discipline the career_path import already uses for job-title names
 * only unique per family). Classification and job family are matched by
 * exact `name_ar` against `competency_classifications`/`job_families`, both
 * genuinely UNIQUE at the DB level, so neither can be ambiguous.
 *
 * A brand-new competency (no existing (domain_id, name_ar) match, the
 * table's own real UNIQUE constraint) requires the definition, expected
 * impact, and all 4 behavioral levels -- every real competency in this
 * framework already has all 4 filled in (CLAUDE.md's own established
 * discipline), so a partial new row is a row-level error, not a
 * half-written competency. A re-imported EXISTING competency only touches
 * the fields the caller both mapped a column to AND ticked in "upsert" mode
 * -- a blank level cell on an update leaves that level's text untouched,
 * matching org_structure_assignments' own "add/update only" import
 * discipline.
 *
 * `competency_levels`' (competency_id, level) uniqueness is a REAL
 * non-partial UNIQUE constraint (see updateCompetencyLevels in actions.ts),
 * so a plain upsert on that conflict target is safe here too -- no
 * select-then-insert-or-update workaround needed for levels, unlike most of
 * this project's other partial-index imports.
 *
 * Every write goes through the caller's own RLS-respecting client -- real
 * authorization is `competencies_insert`/`update`'s own
 * `competencyFramework>=prepare` RLS, not this action's code.
 */
export async function importCompetenciesExcel(
  _prevState: CompetenciesImportResult | null,
  formData: FormData
): Promise<CompetenciesImportResult> {
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
    workbook.worksheets.find((w) => w.name.trim() === "إطار الجدارات") ??
    workbook.worksheets.find((w) => /جدارات/.test(w.name)) ??
    workbook.worksheets[0];
  if (!sheet) {
    return { status: "error", message: "invalid_input" };
  }

  const options = parseImportOptions(formData);
  const cols = applyMapping(headerMap(sheet), options, COMPETENCY_IMPORT_COLUMNS);
  const missingColumn = requireColumns(cols, REQUIRED_COLUMNS);
  if (missingColumn) {
    return { status: "error", message: "invalid_input" };
  }

  const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);

  interface ParsedRow {
    rowNumber: number;
    pillar: string;
    domain: string;
    nameAr: string;
    classification: string;
    jobFamily: string | null;
    definition: string | null;
    expectedImpact: string | null;
    levels: Partial<Record<BehavioralLevel, string>>;
  }

  const parsedRows: ParsedRow[] = [];
  const rowErrors: string[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const nameAr = cellText(get(row, "اسم الجدارة"));
    const pillar = cellText(get(row, "المحور"));
    const domain = cellText(get(row, "المجال"));
    const classification = cellText(get(row, "التصنيف"));
    if (!nameAr && !pillar && !domain && !classification) continue;

    if (!nameAr || !pillar || !domain || !classification) {
      rowErrors.push(`الصف ${r}: بيانات مطلوبة ناقصة (المحور/المجال/اسم الجدارة/التصنيف) — تم التجاوز`);
      continue;
    }

    const levels: ParsedRow["levels"] = {};
    for (const level of behavioralLevelOrder) {
      const text = cellText(get(row, COMPETENCY_IMPORT_COLUMNS[level]));
      if (text) levels[level] = text;
    }

    parsedRows.push({
      rowNumber: r,
      pillar,
      domain,
      nameAr,
      classification,
      jobFamily: cellText(get(row, "العائلة الوظيفية")),
      definition: cellText(get(row, "التعريف")),
      expectedImpact: cellText(get(row, "الأثر المرجو")),
      levels,
    });
  }

  const [{ data: domainsData }, { data: classificationsData }, { data: familiesData }] = await Promise.all([
    supabase.from("competency_domains").select("id, name_ar, competency_pillars(name_ar)"),
    supabase.from("competency_classifications").select("id, name_ar"),
    supabase.from("job_families").select("id, name_ar"),
  ]);

  const domainIdByKey = new Map(
    ((domainsData ?? []) as unknown as Array<{ id: string; name_ar: string; competency_pillars: { name_ar: string } | null }>).map((d) => [
      `${d.competency_pillars?.name_ar ?? ""}::${d.name_ar}`,
      d.id,
    ])
  );
  const classificationIdByName = new Map((classificationsData ?? []).map((c) => [c.name_ar.trim(), c.id]));
  const familyIdByName = new Map((familiesData ?? []).map((f) => [f.name_ar.trim(), f.id]));

  const { data: existingCompetenciesData } = await supabase
    .from("competencies")
    .select("id, domain_id, name_ar")
    .is("deleted_at", null);
  const existingIdByKey = new Map((existingCompetenciesData ?? []).map((c) => [`${c.domain_id}::${c.name_ar}`, c.id]));

  const toInsert: {
    domain_id: string;
    name_ar: string;
    classification_id: string;
    job_family_id: string | null;
    definition_ar: string;
    expected_impact_ar: string;
    levels: Partial<Record<BehavioralLevel, string>>;
  }[] = [];
  const toUpdate: { id: string; row: ParsedRow; classificationId: string; jobFamilyId: string | null }[] = [];

  for (const row of parsedRows) {
    const domainId = domainIdByKey.get(`${row.pillar.trim()}::${row.domain.trim()}`);
    if (!domainId) {
      rowErrors.push(`الصف ${row.rowNumber} ("${row.nameAr}"): المجال "${row.domain}" ضمن المحور "${row.pillar}" غير موجود — تم التجاوز`);
      continue;
    }
    const classificationId = classificationIdByName.get(row.classification.trim());
    if (!classificationId) {
      rowErrors.push(`الصف ${row.rowNumber} ("${row.nameAr}"): التصنيف "${row.classification}" غير موجود — تم التجاوز`);
      continue;
    }
    let jobFamilyId: string | null = null;
    if (row.jobFamily) {
      jobFamilyId = familyIdByName.get(row.jobFamily.trim()) ?? null;
      if (!jobFamilyId) {
        rowErrors.push(`الصف ${row.rowNumber} ("${row.nameAr}"): العائلة الوظيفية "${row.jobFamily}" غير موجودة — تم التجاوز`);
        continue;
      }
    }

    const existingId = existingIdByKey.get(`${domainId}::${row.nameAr}`);
    if (existingId) {
      toUpdate.push({ id: existingId, row, classificationId, jobFamilyId });
      continue;
    }

    if (!row.definition || !row.expectedImpact || behavioralLevelOrder.some((l) => !row.levels[l])) {
      rowErrors.push(`الصف ${row.rowNumber} ("${row.nameAr}"): جدارة جديدة تتطلب التعريف والأثر المرجو والمستويات السلوكية الأربعة كاملة — تم التجاوز`);
      continue;
    }

    toInsert.push({
      domain_id: domainId,
      name_ar: row.nameAr,
      classification_id: classificationId,
      job_family_id: jobFamilyId,
      definition_ar: row.definition,
      expected_impact_ar: row.expectedImpact,
      levels: row.levels,
    });
  }

  let created = 0;
  let updated = 0;

  for (const item of toInsert) {
    const { data: competency, error } = await supabase
      .from("competencies")
      .insert({
        domain_id: item.domain_id,
        name_ar: item.name_ar,
        classification_id: item.classification_id,
        job_family_id: item.job_family_id,
        definition_ar: item.definition_ar,
        expected_impact_ar: item.expected_impact_ar,
      })
      .select("id")
      .single();
    if (error || !competency) {
      rowErrors.push(`الإدراج ("${item.name_ar}"): ${error?.message ?? "unknown"}`);
      continue;
    }
    const levelRows = behavioralLevelOrder.map((level) => ({
      competency_id: competency.id,
      level,
      behavior_ar: item.levels[level]!,
    }));
    const { error: levelsError } = await supabase.from("competency_levels").insert(levelRows);
    if (levelsError) {
      rowErrors.push(`مستويات الجدارة ("${item.name_ar}"): ${levelsError.message}`);
      continue;
    }
    created += 1;
  }

  for (const { id, row, classificationId, jobFamilyId } of toUpdate) {
    // "Add new only" leaves an existing competency exactly as it is.
    if (!updatesExisting(options)) continue;

    const patch: Record<string, unknown> = {};
    if (writesField(options, "classification")) patch.classification_id = classificationId;
    if (writesField(options, "jobFamily") && row.jobFamily) patch.job_family_id = jobFamilyId;
    if (writesField(options, "definition") && row.definition) patch.definition_ar = row.definition;
    if (writesField(options, "expectedImpact") && row.expectedImpact) patch.expected_impact_ar = row.expectedImpact;

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("competencies").update(patch).eq("id", id);
      if (error) {
        rowErrors.push(`تحديث الصف ${row.rowNumber} ("${row.nameAr}"): ${error.message}`);
        continue;
      }
    }

    const levelUpdates = behavioralLevelOrder
      .filter((level) => row.levels[level] && writesField(options, level))
      .map((level) => ({ competency_id: id, level, behavior_ar: row.levels[level]! }));
    if (levelUpdates.length > 0) {
      const { error: levelsError } = await supabase
        .from("competency_levels")
        .upsert(levelUpdates, { onConflict: "competency_id,level" });
      if (levelsError) {
        rowErrors.push(`مستويات الصف ${row.rowNumber} ("${row.nameAr}"): ${levelsError.message}`);
        continue;
      }
    }

    updated += 1;
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "competencies_excel_imported",
    entity: "competencies",
    after_data: { created, updated, rowErrorCount: rowErrors.length },
  });

  return { status: "success", summary: { created, updated, rowErrors } };
}
