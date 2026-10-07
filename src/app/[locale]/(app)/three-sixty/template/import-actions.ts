"use server";

import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { applyMapping, parseImportOptions, updatesExisting, writesField } from "@/lib/excelImportOptions";
import { threeSixtyTemplateColumnLabels, THREE_SIXTY_TEMPLATE_SHEETS } from "@/lib/threeSixtyTemplateExcel";
import { cellNumber, cellText, headerMap, loadImportWorkbook } from "@/lib/excelImport";

export type ImportThreeSixtyTemplateResult =
  | {
      status: "success";
      summary: {
        raterGroups: number;
        ratingScaleOptions: number;
        competencies: number;
        items: number;
        rowErrors: string[];
      };
    }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "unknown" };

/** Accepts common truthy spellings (TRUE/true/1/نعم/صح) -- everything else is false. */
function cellBool(value: ExcelJS.CellValue, fallback: boolean): boolean {
  const text = cellText(value);
  if (text === null) return fallback;
  return ["true", "1", "yes", "نعم", "صح"].includes(text.trim().toLowerCase());
}

const BEHAVIORAL_LEVELS = new Set(["basic", "practitioner", "advanced", "professional"]);

/** Empty or anything not one of the four literal codes means "level-agnostic" (NULL, shown regardless of the subject's resolved level) rather than a rejected row -- an admin adding a general item (like the open-text one) shouldn't need a placeholder value. */
function cellBehavioralLevel(value: ExcelJS.CellValue): string | null {
  const text = cellText(value)?.trim().toLowerCase() ?? null;
  return text && BEHAVIORAL_LEVELS.has(text) ? text : null;
}

function findSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet | undefined {
  return workbook.worksheets.find((w) => w.name.trim() === name);
}

/**
 * Screen 1's "استيراد ملف القالب" -- one workbook, four sheets, one per
 * global catalog table (`rater_group`/`rating_scale`/`competency`/`item`).
 * Cycles themselves are NOT part of this import (created via their own
 * form) -- see 20260902000002's header for why these four tables are
 * cycle-independent, reusable reference data.
 *
 * 2026-09-04 rewrite: now goes through the shared column-mapping/mode
 * machinery (`excelImportOptions.ts`) like every other importer in this
 * app -- a real file rarely uses our exact snake_case headers verbatim, so
 * the caller maps the file's own columns to these fields first (screen 2 of
 * the shared `ExcelImportDialog`) instead of the file being silently
 * ignored when a header doesn't match. `applyMapping` rewrites each sheet's
 * raw header index into the canonical column-label keys below it, so the
 * row-parsing logic itself is unchanged from the original fixed-header
 * version.
 *
 * Mode governs existing rows only, exactly like every other importer:
 * "insert_only" (the default) never touches a row already matched by its
 * natural key, "upsert" also updates it -- on the fields the caller ticked.
 * A brand-new row (no match by natural key) is always inserted in either
 * mode. Nothing is ever deleted.
 *
 * Sheets are processed in dependency order (rating_scale, rater_group,
 * competency, then item, which references the first three) so a
 * brand-new template can be imported in one pass.
 */
export async function importThreeSixtyTemplateExcel(
  _prevState: ImportThreeSixtyTemplateResult | null,
  formData: FormData
): Promise<ImportThreeSixtyTemplateResult> {
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

  const options = parseImportOptions(formData);
  const mayUpdate = updatesExisting(options);

  // Size and row limits are enforced here, not only in the preview dialog
  // (src/lib/excelImport.ts). A limit the import itself does not check is
  // no limit, since this action can be called directly with any file.
  const loaded = await loadImportWorkbook(file);
  if (!loaded.ok) return { status: "error", message: "invalid_input" };
  const workbook = loaded.workbook;

  const rowErrors: string[] = [];
  let raterGroupsWritten = 0;
  let ratingScaleOptionsWritten = 0;
  let competenciesWritten = 0;
  let itemsWritten = 0;

  // ---- rating_scale ---------------------------------------------------
  const ratingScaleSheet = findSheet(workbook, THREE_SIXTY_TEMPLATE_SHEETS.ratingScale);
  if (ratingScaleSheet) {
    const cols = applyMapping(
      headerMap(ratingScaleSheet),
      options,
      threeSixtyTemplateColumnLabels("ratingScale"),
      THREE_SIXTY_TEMPLATE_SHEETS.ratingScale
    );
    const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);
    const { data: existingData } = await supabase
      .from("three_sixty_rating_scale_options")
      .select("id, scale_code, option_code")
      .is("deleted_at", null);
    const existingByKey = new Map((existingData ?? []).map((r) => [`${r.scale_code}::${r.option_code}`, r.id]));

    for (let r = 2; r <= ratingScaleSheet.rowCount; r++) {
      const row = ratingScaleSheet.getRow(r);
      const scaleCode = cellText(get(row, "scale_code"));
      const optionCode = cellText(get(row, "option_code"));
      const labelAr = cellText(get(row, "label_ar"));
      const numericValue = cellNumber(get(row, "numeric_value"));
      if (!scaleCode && !optionCode && !labelAr) continue;
      if (!scaleCode || !optionCode || !labelAr || numericValue === null) {
        rowErrors.push(`rating_scale الصف ${r}: بيانات ناقصة (scale_code/option_code/label_ar/numeric_value) — تم التجاوز`);
        continue;
      }
      const key = `${scaleCode}::${optionCode}`;
      const existingId = existingByKey.get(key);
      if (existingId && !mayUpdate) continue;

      const patch: Record<string, unknown> = { scale_code: scaleCode, option_code: optionCode };
      if (writesField(options, "ratingScale.labelAr")) patch.label_ar = labelAr;
      if (writesField(options, "ratingScale.numericValue")) patch.numeric_value = numericValue;
      if (writesField(options, "ratingScale.countedInScore")) patch.counted_in_score = cellBool(get(row, "counted_in_score"), true);

      const { error } = existingId
        ? await supabase.from("three_sixty_rating_scale_options").update(patch).eq("id", existingId)
        : await supabase.from("three_sixty_rating_scale_options").insert({ counted_in_score: true, ...patch });
      if (error) {
        rowErrors.push(`rating_scale الصف ${r}: ${error.message}`);
      } else {
        ratingScaleOptionsWritten += 1;
      }
    }
  }

  // ---- rater_group ------------------------------------------------------
  const raterGroupSheet = findSheet(workbook, THREE_SIXTY_TEMPLATE_SHEETS.raterGroup);
  if (raterGroupSheet) {
    const cols = applyMapping(
      headerMap(raterGroupSheet),
      options,
      threeSixtyTemplateColumnLabels("raterGroup"),
      THREE_SIXTY_TEMPLATE_SHEETS.raterGroup
    );
    const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);
    const { data: existingData } = await supabase
      .from("three_sixty_rater_groups")
      .select("id, relationship_code")
      .is("deleted_at", null);
    const existingByCode = new Map((existingData ?? []).map((r) => [r.relationship_code, r.id]));

    for (let r = 2; r <= raterGroupSheet.rowCount; r++) {
      const row = raterGroupSheet.getRow(r);
      const relationshipCode = cellText(get(row, "relationship_code"));
      const nameAr = cellText(get(row, "name_ar"));
      if (!relationshipCode && !nameAr) continue;
      if (!relationshipCode || !nameAr) {
        rowErrors.push(`rater_group الصف ${r}: بيانات ناقصة (relationship_code/name_ar) — تم التجاوز`);
        continue;
      }
      const existingId = existingByCode.get(relationshipCode);
      if (existingId && !mayUpdate) continue;

      const patch: Record<string, unknown> = { relationship_code: relationshipCode };
      if (writesField(options, "raterGroup.nameAr")) patch.name_ar = nameAr;
      if (writesField(options, "raterGroup.groupWeightPct")) patch.group_weight_pct = cellNumber(get(row, "group_weight_pct")) ?? 0;
      if (writesField(options, "raterGroup.minRatersInGroup")) patch.min_raters_in_group = cellNumber(get(row, "min_raters_in_group")) ?? 0;
      if (writesField(options, "raterGroup.maxRatersInGroup")) patch.max_raters_in_group = cellNumber(get(row, "max_raters_in_group"));
      if (writesField(options, "raterGroup.shownSeparately")) patch.shown_separately = cellBool(get(row, "shown_separately"), false);
      if (writesField(options, "raterGroup.employeeMayNominate")) patch.employee_may_nominate = cellBool(get(row, "employee_may_nominate"), false);

      const { error } = existingId
        ? await supabase.from("three_sixty_rater_groups").update(patch).eq("id", existingId)
        : await supabase.from("three_sixty_rater_groups").insert({ name_ar: nameAr, ...patch });
      if (error) {
        rowErrors.push(`rater_group الصف ${r}: ${error.message}`);
      } else {
        raterGroupsWritten += 1;
      }
    }
  }

  // ---- competency ---------------------------------------------------
  const competencySheet = findSheet(workbook, THREE_SIXTY_TEMPLATE_SHEETS.competency);
  if (competencySheet) {
    const cols = applyMapping(
      headerMap(competencySheet),
      options,
      threeSixtyTemplateColumnLabels("competency"),
      THREE_SIXTY_TEMPLATE_SHEETS.competency
    );
    const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);
    const { data: existingData } = await supabase
      .from("three_sixty_competencies")
      .select("id, competency_code")
      .is("deleted_at", null);
    const existingByCode = new Map((existingData ?? []).map((r) => [r.competency_code, r.id]));

    for (let r = 2; r <= competencySheet.rowCount; r++) {
      const row = competencySheet.getRow(r);
      const competencyCode = cellText(get(row, "competency_code"));
      const nameAr = cellText(get(row, "name_ar"));
      if (!competencyCode && !nameAr) continue;
      if (!competencyCode || !nameAr) {
        rowErrors.push(`competency الصف ${r}: بيانات ناقصة (competency_code/name_ar) — تم التجاوز`);
        continue;
      }
      const existingId = existingByCode.get(competencyCode);
      if (existingId && !mayUpdate) continue;

      const patch: Record<string, unknown> = { competency_code: competencyCode };
      if (writesField(options, "competency.nameAr")) patch.name_ar = nameAr;
      if (writesField(options, "competency.definitionAr")) patch.definition_ar = cellText(get(row, "definition_ar"));
      if (writesField(options, "competency.weightPct")) patch.weight_pct = cellNumber(get(row, "weight_pct"));
      if (writesField(options, "competency.appliesTo")) patch.applies_to = cellText(get(row, "applies_to"));

      const { error } = existingId
        ? await supabase.from("three_sixty_competencies").update(patch).eq("id", existingId)
        : await supabase.from("three_sixty_competencies").insert({ name_ar: nameAr, ...patch });
      if (error) {
        rowErrors.push(`competency الصف ${r}: ${error.message}`);
      } else {
        competenciesWritten += 1;
      }
    }
  }

  // ---- item ---------------------------------------------------------
  const itemSheet = findSheet(workbook, THREE_SIXTY_TEMPLATE_SHEETS.item);
  if (itemSheet) {
    const cols = applyMapping(
      headerMap(itemSheet),
      options,
      threeSixtyTemplateColumnLabels("item"),
      THREE_SIXTY_TEMPLATE_SHEETS.item
    );
    const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);
    const [{ data: competencyRows }, { data: existingItems }] = await Promise.all([
      supabase.from("three_sixty_competencies").select("id, competency_code").is("deleted_at", null),
      supabase.from("three_sixty_items").select("id, item_code").is("deleted_at", null),
    ]);
    const competencyIdByCode = new Map((competencyRows ?? []).map((c) => [c.competency_code, c.id]));
    const existingItemByCode = new Map((existingItems ?? []).map((i) => [i.item_code, i.id]));

    for (let r = 2; r <= itemSheet.rowCount; r++) {
      const row = itemSheet.getRow(r);
      const itemCode = cellText(get(row, "item_code"));
      const textAr = cellText(get(row, "text_ar"));
      const competencyCode = cellText(get(row, "competency_code"));
      if (!itemCode && !textAr) continue;
      if (!itemCode || !textAr || !competencyCode) {
        rowErrors.push(`item الصف ${r}: بيانات ناقصة (item_code/competency_code/text_ar) — تم التجاوز`);
        continue;
      }
      const competencyId = competencyIdByCode.get(competencyCode);
      if (!competencyId) {
        rowErrors.push(`item الصف ${r}: الجدارة "${competencyCode}" غير موجودة — تم التجاوز`);
        continue;
      }
      const itemType = cellText(get(row, "item_type")) === "open_text" ? "open_text" : "rating";
      const raterGroupsRaw = cellText(get(row, "rater_groups")) ?? "";
      const raterGroups = raterGroupsRaw
        .split(/[,،]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (raterGroups.length === 0) {
        rowErrors.push(`item الصف ${r}: عمود rater_groups فارغ — تم التجاوز`);
        continue;
      }
      const scaleCode = cellText(get(row, "scale_code"));
      if (itemType === "rating" && !scaleCode) {
        rowErrors.push(`item الصف ${r}: عبارة من نوع rating بلا scale_code — تم التجاوز`);
        continue;
      }
      const existingId = existingItemByCode.get(itemCode);
      if (existingId && !mayUpdate) continue;

      const patch: Record<string, unknown> = { item_code: itemCode };
      if (writesField(options, "item.competencyCode")) patch.competency_id = competencyId;
      if (writesField(options, "item.itemType")) patch.item_type = itemType;
      if (writesField(options, "item.textAr")) patch.text_ar = textAr;
      if (writesField(options, "item.raterGroups")) patch.rater_groups = raterGroups;
      if (writesField(options, "item.required")) patch.required = cellBool(get(row, "required"), true);
      if (writesField(options, "item.reverseScored")) patch.reverse_scored = cellBool(get(row, "reverse_scored"), false);
      if (writesField(options, "item.scaleCode")) patch.scale_code = itemType === "rating" ? scaleCode : null;
      if (writesField(options, "item.displayOrder")) patch.display_order = cellNumber(get(row, "display_order")) ?? 0;
      if (writesField(options, "item.behavioralLevel")) patch.behavioral_level = cellBehavioralLevel(get(row, "behavioral_level"));

      const { error } = existingId
        ? await supabase.from("three_sixty_items").update(patch).eq("id", existingId)
        : await supabase.from("three_sixty_items").insert({ competency_id: competencyId, item_type: itemType, text_ar: textAr, rater_groups: raterGroups, ...patch });
      if (error) {
        rowErrors.push(`item الصف ${r}: ${error.message}`);
      } else {
        itemsWritten += 1;
      }
    }
  }

  if (!ratingScaleSheet && !raterGroupSheet && !competencySheet && !itemSheet) {
    return { status: "error", message: "invalid_input" };
  }

  return {
    status: "success",
    summary: {
      raterGroups: raterGroupsWritten,
      ratingScaleOptions: ratingScaleOptionsWritten,
      competencies: competenciesWritten,
      items: itemsWritten,
      rowErrors,
    },
  };
}
