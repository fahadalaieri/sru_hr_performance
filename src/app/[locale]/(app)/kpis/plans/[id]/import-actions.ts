"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyMapping, parseImportOptions, updatesExisting, writesField } from "@/lib/excelImportOptions";
import { revalidatePath } from "next/cache";
import {
  cellDateIso,
  cellNumber,
  cellText,
  headerIndex,
  pickWritableColumns,
  planSheetColumnLabels,
  STRATEGIC_PLAN_COLUMNS,
  STRATEGIC_PLAN_SHEETS,
  type StrategicPlanSheetKey,
} from "@/lib/strategicPlanExcel";
import { loadImportWorkbook } from "@/lib/excelImport";

export type ImportStrategicPlanState =
  | {
      status: "success";
      summary: {
        identityUpdated: boolean;
        valuesCreated: number;
        valuesUpdated: number;
        goalsCreated: number;
        goalsUpdated: number;
        subGoalsCreated: number;
        subGoalsUpdated: number;
        kpisCreated: number;
        kpisUpdated: number;
        annualTargetsCreated: number;
        annualTargetsUpdated: number;
        programsCreated: number;
        programsUpdated: number;
        initiativesCreated: number;
        initiativesUpdated: number;
      };
      warnings: string[];
    }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "not_found" | "no_sheets" | "unknown"; detail?: string }
  | null;

const idSchema = z.string().uuid();

/**
 * Imports a workbook produced by /api/strategic-plans/[id]/export back into
 * the same plan. There is deliberately no separate hand-built template:
 * export IS the template, so the two can never drift (unlike the employees
 * / org-structure imports, each of which ships its own .xlsx).
 *
 * Behaviour, matching every other import in this app: rows are matched by
 * NAME and updated in place, unmatched names are created, and nothing is
 * ever deleted — a row removed from the sheet stays in the database. A row
 * that cannot be resolved (unknown cycle, unknown owner position, ambiguous
 * parent) is skipped with an explanatory warning rather than aborting the
 * whole file.
 *
 * Every write goes through the CALLER's own RLS-respecting client, so real
 * authorization stays where it already lives: strategic_goals/sub_goals/
 * strategic_kpis/kpi_annual_targets require
 * check_vpra_global('strategicPlanning','approve'), while
 * strategic_identity/strategic_values sit at 'prepare' (20260730000002).
 * An under-privileged caller therefore gets per-row warnings, never a
 * silent write.
 *
 * Sheets are all optional — a workbook holding only "القيم" imports just
 * values. The export-only "الأهداف المسندة" sheet is ignored on import:
 * re-creating an assignment needs position/employee resolution and its own
 * RLS story, deliberately left to its own slice.
 */
export async function importStrategicPlanExcel(
  _prevState: ImportStrategicPlanState,
  formData: FormData
): Promise<ImportStrategicPlanState> {
  const planId = formData.get("planId");
  const parsedId = idSchema.safeParse(planId);
  if (!parsedId.success) return { status: "error", message: "invalid_input" };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { status: "error", message: "invalid_input" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "unauthenticated" };

  const { data: plan } = await supabase
    .from("strategic_plans")
    .select("id")
    .eq("id", parsedId.data)
    .is("deleted_at", null)
    .maybeSingle();
  if (!plan) return { status: "error", message: "not_found" };

  const { data: myProfile } = await supabase.from("profiles").select("id").eq("auth_user_id", user.id).maybeSingle();
  const myProfileId = (myProfile?.id as string | undefined) ?? null;

  // Size and row limits are enforced here, not only in the preview dialog
  // (src/lib/excelImport.ts). A limit the import itself does not check is
  // no limit, since this action can be called directly with any file.
  const loaded = await loadImportWorkbook(file);
  if (!loaded.ok) return { status: "error", message: "invalid_input" };
  const workbook = loaded.workbook;

  const options = parseImportOptions(formData);
  // "Add new only" is the default: every sheet below creates what is missing
  // and leaves what already exists exactly as it is. Column mapping and field
  // selection are deliberately not offered for this workbook — its nine sheets
  // and their columns ARE this app's own export format, so there is nothing to
  // map them to.
  const mayUpdate = updatesExisting(options);
  const warnings: string[] = [];
  const summary = {
    identityUpdated: false,
    valuesCreated: 0,
    valuesUpdated: 0,
    goalsCreated: 0,
    goalsUpdated: 0,
    subGoalsCreated: 0,
    subGoalsUpdated: 0,
    kpisCreated: 0,
    kpisUpdated: 0,
    annualTargetsCreated: 0,
    annualTargetsUpdated: 0,
    programsCreated: 0,
    programsUpdated: 0,
    initiativesCreated: 0,
    initiativesUpdated: 0,
  };

  /**
   * Sheet -> [{columnLabel: value}] with the header row validated.
   *
   * The caller's column mapping is applied HERE, per sheet: a header they
   * pointed at a field is renamed to the label the rest of this function reads
   * by, one they ignored is dropped, and anything they left alone keeps its own
   * name. Per sheet specifically, because this workbook repeats header names
   * across sheets — a single flat mapping would make one choice govern all of
   * them (see STRATEGIC_PLAN_FIELDS).
   */
  function readSheet(
    sheetName: string,
    columns: readonly string[],
    sheetKey: StrategicPlanSheetKey
  ): Array<Record<string, unknown>> | null {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) return null;
    const headerRow = (sheet.getRow(1).values as unknown[]) ?? [];
    const index = applyMapping(
      headerIndex(headerRow.slice(1)),
      options,
      planSheetColumnLabels(sheetKey),
      sheetName
    );
    const missing = columns.filter((label) => !index.has(label));
    if (missing.length > 0) {
      warnings.push(`ورقة «${sheetName}»: أعمدة ناقصة (${missing.join("، ")}) — تم تخطّيها.`);
      return null;
    }
    const rows: Array<Record<string, unknown>> = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const record: Record<string, unknown> = {};
      let hasAnyValue = false;
      for (const label of columns) {
        const value = row.getCell(index.get(label)!).value;
        record[label] = value;
        if (cellText(value) !== "") hasAnyValue = true;
      }
      record.__row = rowNumber;
      if (hasAnyValue) rows.push(record);
    });
    return rows;
  }

  /**
   * Drops the columns whose field the caller did not tick, per sheet.
   *
   * Dropping, not blanking: an unticked field must be left exactly as the
   * platform has it, and writing null for it would erase a real value.
   */
  function writable<T extends Record<string, unknown>>(payload: T, sheetKey: StrategicPlanSheetKey): Partial<T> {
    return pickWritableColumns(payload, sheetKey, (field) => writesField(options, field));
  }

  let touchedAnySheet = false;

  // ---------- 1) الرؤية والرسالة (global singleton) ----------
  const identityRows = readSheet(STRATEGIC_PLAN_SHEETS.identity, STRATEGIC_PLAN_COLUMNS.identity, "identity");
  if (identityRows) {
    touchedAnySheet = true;
    const row = identityRows[0];
    if (row) {
      const payload = {
        vision_ar: cellText(row["الرؤية (عربي)"]) || null,
        vision_en: cellText(row["الرؤية (إنجليزي)"]) || null,
        mission_ar: cellText(row["الرسالة (عربي)"]) || null,
        mission_en: cellText(row["الرسالة (إنجليزي)"]) || null,
        updated_by: myProfileId,
      };
      const { data: existing } = await supabase.from("strategic_identity").select("id").maybeSingle();
      // .select() on the UPDATE is load-bearing, not cosmetic: an UPDATE
      // blocked by RLS affects zero rows and returns NO error, so without
      // reading the affected rows back this would report a successful save
      // that never happened (caught live, 2026-08-19).
      const { data: saved, error } = existing
        ? mayUpdate
          ? await supabase.from("strategic_identity").update(writable(payload, "identity")).eq("id", existing.id).select("id")
          : { data: null, error: null }
        : await supabase.from("strategic_identity").insert(writable(payload, "identity")).select("id");
      if (error) warnings.push(`الرؤية والرسالة: تعذّر الحفظ (${error.code ?? "خطأ"}) — تحقّق من صلاحيتك.`);
      else if (!saved || saved.length === 0) warnings.push("الرؤية والرسالة: لا تملك صلاحية التعديل — لم يتم الحفظ.");
      else summary.identityUpdated = true;
    }
  }

  // ---------- 2) القيم (global) ----------
  const valueRows = readSheet(STRATEGIC_PLAN_SHEETS.values, STRATEGIC_PLAN_COLUMNS.values, "values");
  if (valueRows) {
    touchedAnySheet = true;
    const { data: existingValues } = await supabase
      .from("strategic_values")
      .select("id, title_ar, display_order")
      .is("deleted_at", null);
    const valueByTitle = new Map(
      ((existingValues ?? []) as Array<{ id: string; title_ar: string; display_order: number }>).map((v) => [v.title_ar, v])
    );
    let nextOrder =
      Math.max(0, ...((existingValues ?? []) as Array<{ display_order: number }>).map((v) => v.display_order)) + 1;

    for (const row of valueRows) {
      const titleAr = cellText(row["القيمة (عربي)"]);
      if (titleAr === "") {
        warnings.push(`القيم (صف ${row.__row}): القيمة (عربي) مطلوبة — تم تخطّي الصف.`);
        continue;
      }
      const order = cellNumber(row["الترتيب"]);
      if (order === undefined) {
        warnings.push(`القيم (صف ${row.__row}): «الترتيب» ليس رقمًا — تم تخطّي الصف.`);
        continue;
      }
      const payload = {
        title_ar: titleAr,
        title_en: cellText(row["القيمة (إنجليزي)"]) || null,
        description_ar: cellText(row["الوصف (عربي)"]) || null,
        description_en: cellText(row["الوصف (إنجليزي)"]) || null,
      };
      const existing = valueByTitle.get(titleAr);
      if (existing) {
        if (!mayUpdate) continue;
        const { data: saved, error } = await supabase
          .from("strategic_values")
          .update(writable({ ...payload, display_order: order ?? existing.display_order }, "values"))
          .eq("id", existing.id)
          .select("id");
        if (error) warnings.push(`القيم (صف ${row.__row}): تعذّر التحديث (${error.code ?? "خطأ"}).`);
        else if (!saved || saved.length === 0) warnings.push(`القيم (صف ${row.__row}): لا تملك صلاحية التعديل — لم يتم التحديث.`);
        else summary.valuesUpdated += 1;
      } else {
        const { error } = await supabase
          .from("strategic_values")
          .insert(writable({ ...payload, display_order: order ?? nextOrder++, created_by: myProfileId }, "values"));
        if (error) warnings.push(`القيم (صف ${row.__row}): تعذّر الإضافة (${error.code ?? "خطأ"}).`);
        else summary.valuesCreated += 1;
      }
    }
  }

  // ---------- shared lookups for the plan-scoped sheets ----------
  const { data: cyclesData } = await supabase.from("evaluation_cycles").select("id, name_ar").is("deleted_at", null);
  const cycles = (cyclesData ?? []) as Array<{ id: string; name_ar: string }>;
  const cycleIdsByName = new Map<string, string[]>();
  for (const c of cycles) {
    const list = cycleIdsByName.get(c.name_ar) ?? [];
    list.push(c.id);
    cycleIdsByName.set(c.name_ar, list);
  }

  const { data: positionsData } = await supabase.rpc("list_org_structure_positions");
  const positionIdsByName = new Map<string, string[]>();
  for (const p of (positionsData ?? []) as Array<{ id: string; name_ar: string }>) {
    const list = positionIdsByName.get(p.name_ar) ?? [];
    list.push(p.id);
    positionIdsByName.set(p.name_ar, list);
  }

  /** Exactly-one-match lookup; anything else is a skip with a reason. */
  function resolveUnique(map: Map<string, string[]>, name: string): { id: string } | { error: "missing" | "ambiguous" } {
    const matches = map.get(name) ?? [];
    if (matches.length === 1) return { id: matches[0] };
    return { error: matches.length === 0 ? "missing" : "ambiguous" };
  }

  // Re-read after every write pass so a sheet can reference rows created by
  // an earlier sheet in the SAME import (sub-goals under a goal added by the
  // goals sheet, KPIs under that sub-goal, and so on).
  async function loadGoals() {
    const { data } = await supabase
      .from("strategic_goals")
      .select("id, title_ar")
      .eq("plan_id", parsedId.data)
      .is("deleted_at", null);
    const byTitle = new Map<string, string[]>();
    for (const g of (data ?? []) as Array<{ id: string; title_ar: string }>) {
      const list = byTitle.get(g.title_ar) ?? [];
      list.push(g.id);
      byTitle.set(g.title_ar, list);
    }
    return byTitle;
  }

  // ---------- 3) الأهداف الاستراتيجية ----------
  const goalRows = readSheet(STRATEGIC_PLAN_SHEETS.goals, STRATEGIC_PLAN_COLUMNS.goals, "goals");
  if (goalRows) {
    touchedAnySheet = true;
    const goalIdsByTitle = await loadGoals();
    for (const row of goalRows) {
      const titleAr = cellText(row["الهدف الاستراتيجي (عربي)"]);
      if (titleAr === "") {
        warnings.push(`الأهداف الاستراتيجية (صف ${row.__row}): اسم الهدف مطلوب — تم تخطّي الصف.`);
        continue;
      }
      const weight = cellNumber(row["الوزن %"]);
      if (weight === undefined) {
        warnings.push(`الأهداف الاستراتيجية (صف ${row.__row}): «الوزن %» ليس رقمًا — تم تخطّي الصف.`);
        continue;
      }
      const payload = {
        title_ar: titleAr,
        title_en: cellText(row["الهدف الاستراتيجي (إنجليزي)"]) || null,
        description_ar: cellText(row["الوصف (عربي)"]) || null,
        description_en: cellText(row["الوصف (إنجليزي)"]) || null,
        weight,
      };
      const existing = goalIdsByTitle.get(titleAr) ?? [];
      if (existing.length > 1) {
        warnings.push(`الأهداف الاستراتيجية (صف ${row.__row}): يوجد أكثر من هدف بنفس الاسم — تم تخطّي الصف.`);
        continue;
      }
      if (existing.length === 1) {
        if (!mayUpdate) continue;
        const { data: saved, error } = await supabase.from("strategic_goals").update(writable(payload, "goals")).eq("id", existing[0]).select("id");
        if (error) warnings.push(`الأهداف الاستراتيجية (صف ${row.__row}): تعذّر التحديث (${error.code ?? "خطأ"}).`);
        else if (!saved || saved.length === 0)
          warnings.push(`الأهداف الاستراتيجية (صف ${row.__row}): لا تملك صلاحية التعديل — لم يتم التحديث.`);
        else summary.goalsUpdated += 1;
        continue;
      }
      const { error } = await supabase
        .from("strategic_goals")
        .insert({ ...payload, plan_id: parsedId.data, created_by: myProfileId });
      if (error) warnings.push(`الأهداف الاستراتيجية (صف ${row.__row}): تعذّر الإضافة (${error.code ?? "خطأ"}).`);
      else summary.goalsCreated += 1;
    }
  }

  // ---------- 4) الأهداف الفرعية ----------
  const subGoalRows = readSheet(STRATEGIC_PLAN_SHEETS.subGoals, STRATEGIC_PLAN_COLUMNS.subGoals, "subGoals");
  const goalIdsByTitle = await loadGoals();
  if (subGoalRows) {
    touchedAnySheet = true;
    for (const row of subGoalRows) {
      const goalTitle = cellText(row["الهدف الاستراتيجي"]);
      const titleAr = cellText(row["الهدف الفرعي (عربي)"]);
      const ownerName = cellText(row["المالك (المنصب)"]);
      if (titleAr === "") {
        warnings.push(`الأهداف الفرعية (صف ${row.__row}): اسم الهدف الفرعي مطلوب — تم تخطّي الصف.`);
        continue;
      }
      const goal = resolveUnique(goalIdsByTitle, goalTitle);
      if ("error" in goal) {
        warnings.push(
          `الأهداف الفرعية (صف ${row.__row}): ${
            goal.error === "missing" ? `الهدف الاستراتيجي «${goalTitle}» غير موجود في هذه الخطة` : `اسم الهدف «${goalTitle}» مكرّر`
          } — تم تخطّي الصف.`
        );
        continue;
      }
      const weight = cellNumber(row["الوزن %"]);
      if (weight === undefined) {
        warnings.push(`الأهداف الفرعية (صف ${row.__row}): «الوزن %» ليس رقمًا — تم تخطّي الصف.`);
        continue;
      }
      const payload = {
        title_ar: titleAr,
        title_en: cellText(row["الهدف الفرعي (إنجليزي)"]) || null,
        description_ar: cellText(row["الوصف (عربي)"]) || null,
        description_en: cellText(row["الوصف (إنجليزي)"]) || null,
        weight,
      };
      const { data: existingSub } = await supabase
        .from("sub_goals")
        .select("id")
        .eq("strategic_goal_id", goal.id)
        .eq("title_ar", titleAr)
        .is("deleted_at", null)
        .maybeSingle();
      if (existingSub) {
        if (!mayUpdate) continue;
        const { data: saved, error } = await supabase.from("sub_goals").update(writable(payload, "subGoals")).eq("id", existingSub.id).select("id");
        if (error) warnings.push(`الأهداف الفرعية (صف ${row.__row}): تعذّر التحديث (${error.code ?? "خطأ"}).`);
        else if (!saved || saved.length === 0)
          warnings.push(`الأهداف الفرعية (صف ${row.__row}): لا تملك صلاحية التعديل — لم يتم التحديث.`);
        else summary.subGoalsUpdated += 1;
        continue;
      }
      const owner = resolveUnique(positionIdsByName, ownerName);
      if ("error" in owner) {
        warnings.push(
          `الأهداف الفرعية (صف ${row.__row}): ${
            owner.error === "missing" ? `المنصب «${ownerName}» غير موجود` : `اسم المنصب «${ownerName}» مكرّر`
          } — تم تخطّي الصف.`
        );
        continue;
      }
      const { error } = await supabase
        .from("sub_goals")
        .insert({ ...payload, strategic_goal_id: goal.id, owner_position_id: owner.id, created_by: myProfileId });
      if (error) warnings.push(`الأهداف الفرعية (صف ${row.__row}): تعذّر الإضافة (${error.code ?? "خطأ"}).`);
      else summary.subGoalsCreated += 1;
    }
  }

  // ---------- 5) المؤشرات ----------
  /** Resolves a KPI row's parent: sub-goal when named, else the goal. */
  async function resolveKpiParent(
    goalTitle: string,
    subGoalTitle: string
  ): Promise<{ strategic_goal_id: string | null; sub_goal_id: string | null } | { error: string }> {
    const goal = resolveUnique(goalIdsByTitle, goalTitle);
    if ("error" in goal) {
      return {
        error: goal.error === "missing" ? `الهدف الاستراتيجي «${goalTitle}» غير موجود في هذه الخطة` : `اسم الهدف «${goalTitle}» مكرّر`,
      };
    }
    if (subGoalTitle === "") return { strategic_goal_id: goal.id, sub_goal_id: null };
    const { data: sub } = await supabase
      .from("sub_goals")
      .select("id")
      .eq("strategic_goal_id", goal.id)
      .eq("title_ar", subGoalTitle)
      .is("deleted_at", null)
      .maybeSingle();
    if (!sub) return { error: `الهدف الفرعي «${subGoalTitle}» غير موجود تحت «${goalTitle}»` };
    return { strategic_goal_id: null, sub_goal_id: sub.id as string };
  }

  const kpiRows = readSheet(STRATEGIC_PLAN_SHEETS.kpis, STRATEGIC_PLAN_COLUMNS.kpis, "kpis");
  if (kpiRows) {
    touchedAnySheet = true;
    for (const row of kpiRows) {
      const titleAr = cellText(row["المؤشر (عربي)"]);
      const unitAr = cellText(row["وحدة القياس"]);
      if (titleAr === "" || unitAr === "") {
        warnings.push(`المؤشرات (صف ${row.__row}): اسم المؤشر ووحدة القياس مطلوبان — تم تخطّي الصف.`);
        continue;
      }
      const parent = await resolveKpiParent(cellText(row["الهدف الاستراتيجي"]), cellText(row["الهدف الفرعي"]));
      if ("error" in parent) {
        warnings.push(`المؤشرات (صف ${row.__row}): ${parent.error} — تم تخطّي الصف.`);
        continue;
      }
      const planTarget = cellNumber(row["مستهدف الخطة"]);
      const weight = cellNumber(row["الوزن %"]);
      if (planTarget === undefined || weight === undefined) {
        warnings.push(`المؤشرات (صف ${row.__row}): قيمة رقمية غير صالحة — تم تخطّي الصف.`);
        continue;
      }
      const payload = {
        title_ar: titleAr,
        title_en: cellText(row["المؤشر (إنجليزي)"]) || null,
        unit_ar: unitAr,
        plan_target_value: planTarget,
        weight,
      };
      const parentFilter = parent.strategic_goal_id
        ? { column: "strategic_goal_id", value: parent.strategic_goal_id }
        : { column: "sub_goal_id", value: parent.sub_goal_id! };
      const { data: existingKpi } = await supabase
        .from("strategic_kpis")
        .select("id")
        .eq(parentFilter.column, parentFilter.value)
        .eq("title_ar", titleAr)
        .is("deleted_at", null)
        .maybeSingle();
      if (existingKpi) {
        if (!mayUpdate) continue;
        const { data: saved, error } = await supabase.from("strategic_kpis").update(writable(payload, "kpis")).eq("id", existingKpi.id).select("id");
        if (error) warnings.push(`المؤشرات (صف ${row.__row}): تعذّر التحديث (${error.code ?? "خطأ"}).`);
        else if (!saved || saved.length === 0)
          warnings.push(`المؤشرات (صف ${row.__row}): لا تملك صلاحية التعديل — لم يتم التحديث.`);
        else summary.kpisUpdated += 1;
        continue;
      }
      const { error } = await supabase.from("strategic_kpis").insert({ ...payload, ...parent, created_by: myProfileId });
      if (error) warnings.push(`المؤشرات (صف ${row.__row}): تعذّر الإضافة (${error.code ?? "خطأ"}).`);
      else summary.kpisCreated += 1;
    }
  }

  // ---------- 6) المستهدفات السنوية ----------
  const annualRows = readSheet(STRATEGIC_PLAN_SHEETS.annualTargets, STRATEGIC_PLAN_COLUMNS.annualTargets, "annualTargets");
  if (annualRows) {
    touchedAnySheet = true;
    for (const row of annualRows) {
      const kpiTitle = cellText(row["المؤشر"]);
      const cycleName = cellText(row["دورة التقييم"]);
      if (kpiTitle === "") {
        warnings.push(`المستهدفات السنوية (صف ${row.__row}): اسم المؤشر مطلوب — تم تخطّي الصف.`);
        continue;
      }
      const parent = await resolveKpiParent(cellText(row["الهدف الاستراتيجي"]), cellText(row["الهدف الفرعي"]));
      if ("error" in parent) {
        warnings.push(`المستهدفات السنوية (صف ${row.__row}): ${parent.error} — تم تخطّي الصف.`);
        continue;
      }
      const parentFilter = parent.strategic_goal_id
        ? { column: "strategic_goal_id", value: parent.strategic_goal_id }
        : { column: "sub_goal_id", value: parent.sub_goal_id! };
      const { data: kpi } = await supabase
        .from("strategic_kpis")
        .select("id")
        .eq(parentFilter.column, parentFilter.value)
        .eq("title_ar", kpiTitle)
        .is("deleted_at", null)
        .maybeSingle();
      if (!kpi) {
        warnings.push(`المستهدفات السنوية (صف ${row.__row}): المؤشر «${kpiTitle}» غير موجود — تم تخطّي الصف.`);
        continue;
      }
      const cycle = resolveUnique(cycleIdsByName, cycleName);
      if ("error" in cycle) {
        warnings.push(
          `المستهدفات السنوية (صف ${row.__row}): ${
            cycle.error === "missing" ? `دورة التقييم «${cycleName}» غير موجودة` : `اسم دورة التقييم «${cycleName}» مكرّر`
          } — تم تخطّي الصف.`
        );
        continue;
      }
      const targetValue = cellNumber(row["القيمة المستهدفة"]);
      const actualValue = cellNumber(row["القيمة الفعلية"]);
      if (targetValue === undefined || actualValue === undefined || targetValue === null) {
        warnings.push(`المستهدفات السنوية (صف ${row.__row}): «القيمة المستهدفة» مطلوبة ورقمية — تم تخطّي الصف.`);
        continue;
      }
      // kpi_annual_targets' uniqueness is a PARTIAL index
      // (kpi_id, cycle_id) WHERE deleted_at IS NULL, which PostgREST's
      // on_conflict inference can't target — same select-then-insert-or-update
      // workaround this project already uses for evaluation_scores /
      // calibration_results / org_structure_positions.
      const { data: existingTarget } = await supabase
        .from("kpi_annual_targets")
        .select("id")
        .eq("kpi_id", kpi.id)
        .eq("cycle_id", cycle.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (existingTarget) {
        if (!mayUpdate) continue;
        const { data: saved, error } = await supabase
          .from("kpi_annual_targets")
          .update(writable({ target_value: targetValue, actual_value: actualValue }, "annualTargets"))
          .eq("id", existingTarget.id)
          .select("id");
        if (error) warnings.push(`المستهدفات السنوية (صف ${row.__row}): تعذّر التحديث (${error.code ?? "خطأ"}).`);
        else if (!saved || saved.length === 0)
          warnings.push(`المستهدفات السنوية (صف ${row.__row}): لا تملك صلاحية التعديل — لم يتم التحديث.`);
        else summary.annualTargetsUpdated += 1;
      } else {
        const { error } = await supabase.from("kpi_annual_targets").insert({
          kpi_id: kpi.id,
          cycle_id: cycle.id,
          target_value: targetValue,
          actual_value: actualValue,
          created_by: myProfileId,
        });
        if (error) warnings.push(`المستهدفات السنوية (صف ${row.__row}): تعذّر الإضافة (${error.code ?? "خطأ"}).`);
        else summary.annualTargetsCreated += 1;
      }
    }
  }

  // ---------- 7) البرامج ----------
  // `strategic_programs` has NO unique constraint on (plan_id, name_ar), so
  // the name is treated as the row's identity in code — [استنتاج], the same
  // choice the vacancies import made for a table with no natural key. A name
  // used twice in this plan is skipped rather than guessed at, so a re-import
  // can never quietly overwrite the wrong program.
  const programRows = readSheet(STRATEGIC_PLAN_SHEETS.programs, STRATEGIC_PLAN_COLUMNS.programs, "programs");
  if (programRows) {
    touchedAnySheet = true;
    const { data: existingPrograms } = await supabase
      .from("strategic_programs")
      .select("id, name_ar")
      .eq("plan_id", parsedId.data)
      .is("deleted_at", null);
    const programIdsByName = new Map<string, string[]>();
    for (const p of (existingPrograms ?? []) as Array<{ id: string; name_ar: string }>) {
      programIdsByName.set(p.name_ar, [...(programIdsByName.get(p.name_ar) ?? []), p.id]);
    }

    for (const row of programRows) {
      const nameAr = cellText(row["اسم البرنامج (عربي)"]);
      if (nameAr === "") {
        warnings.push(`البرامج (صف ${row.__row}): اسم البرنامج مطلوب — تم تخطّي الصف.`);
        continue;
      }
      const startDate = cellDateIso(row["تاريخ البداية"]);
      const endDate = cellDateIso(row["تاريخ النهاية"]);
      if (startDate === undefined || endDate === undefined) {
        warnings.push(`البرامج (صف ${row.__row}): التاريخ غير صالح (المتوقّع YYYY-MM-DD) — تم تخطّي الصف.`);
        continue;
      }
      // Mirrors strategic_programs_dates_valid, so the reader gets the real
      // reason instead of a raw 23514 from Postgres.
      if (startDate && endDate && endDate < startDate) {
        warnings.push(`البرامج (صف ${row.__row}): تاريخ النهاية قبل تاريخ البداية — تم تخطّي الصف.`);
        continue;
      }
      const status = cellText(row["الحالة"]);
      const payload = {
        name_ar: nameAr,
        name_en: cellText(row["اسم البرنامج (إنجليزي)"]) || null,
        description_ar: cellText(row["الوصف (عربي)"]) || null,
        start_date: startDate,
        end_date: endDate,
        // The column is NOT NULL DEFAULT 'planned'; a blank cell on an
        // existing program must not blank out its real status.
        ...(status === "" ? {} : { status }),
      };
      const existing = programIdsByName.get(nameAr) ?? [];
      if (existing.length > 1) {
        warnings.push(`البرامج (صف ${row.__row}): يوجد أكثر من برنامج بنفس الاسم — تم تخطّي الصف.`);
        continue;
      }
      if (existing.length === 1) {
        if (!mayUpdate) continue;
        const { data: saved, error } = await supabase
          .from("strategic_programs")
          .update(writable(payload, "programs"))
          .eq("id", existing[0])
          .select("id");
        if (error) warnings.push(`البرامج (صف ${row.__row}): تعذّر التحديث (${error.code ?? "خطأ"}).`);
        else if (!saved || saved.length === 0)
          warnings.push(`البرامج (صف ${row.__row}): لا تملك صلاحية التعديل — لم يتم التحديث.`);
        else summary.programsUpdated += 1;
        continue;
      }
      const { data: created, error } = await supabase
        .from("strategic_programs")
        .insert({ ...payload, plan_id: parsedId.data, created_by: myProfileId })
        .select("id");
      if (error) warnings.push(`البرامج (صف ${row.__row}): تعذّر الإضافة (${error.code ?? "خطأ"}).`);
      else {
        summary.programsCreated += 1;
        // So a workbook repeating the same new name twice updates the row it
        // just created instead of inserting a second one.
        if (created?.[0]?.id) programIdsByName.set(nameAr, [created[0].id as string]);
      }
    }
  }

  // ---------- 8) المبادرات ----------
  // Same identity rule as the programs sheet: `strategic_initiatives` has
  // no unique constraint on (plan_id, title_ar), so the title is the row's
  // identity in code and a title used twice in this plan is skipped rather
  // than guessed at. The targets an initiative serves are NOT in the sheet
  // (one initiative can serve several), so importing never touches them.
  const initiativeRows = readSheet(STRATEGIC_PLAN_SHEETS.initiatives, STRATEGIC_PLAN_COLUMNS.initiatives, "initiatives");
  if (initiativeRows) {
    touchedAnySheet = true;
    const { data: existingInitiatives } = await supabase
      .from("strategic_initiatives")
      .select("id, title_ar")
      .eq("plan_id", parsedId.data)
      .is("deleted_at", null);
    const initiativeIdsByTitle = new Map<string, string[]>();
    for (const i of (existingInitiatives ?? []) as Array<{ id: string; title_ar: string }>) {
      initiativeIdsByTitle.set(i.title_ar, [...(initiativeIdsByTitle.get(i.title_ar) ?? []), i.id]);
    }

    const { data: orgUnitRows } = await supabase.from("org_units").select("id, name_ar").is("deleted_at", null);
    const orgUnitIdsByName = new Map<string, string[]>();
    for (const u of (orgUnitRows ?? []) as Array<{ id: string; name_ar: string }>) {
      orgUnitIdsByName.set(u.name_ar, [...(orgUnitIdsByName.get(u.name_ar) ?? []), u.id]);
    }
    // Sub-goals of THIS plan only, keyed by title: the sheet names a
    // sub-goal without its parent goal, so the map is scoped by the plan’s
    // own goal ids rather than matching a title from another plan.
    const planGoalIds = Array.from((await loadGoals()).values()).flat();
    const { data: subGoalRowsForInitiatives } =
      planGoalIds.length > 0
        ? await supabase.from("sub_goals").select("id, title_ar").in("strategic_goal_id", planGoalIds).is("deleted_at", null)
        : { data: [] };
    const subGoalsNow = new Map<string, string[]>();
    for (const sg of (subGoalRowsForInitiatives ?? []) as Array<{ id: string; title_ar: string }>) {
      subGoalsNow.set(sg.title_ar, [...(subGoalsNow.get(sg.title_ar) ?? []), sg.id]);
    }

    for (const row of initiativeRows) {
      const titleAr = cellText(row["المبادرة (عربي)"]);
      if (titleAr === "") {
        warnings.push(`المبادرات (صف ${row.__row}): اسم المبادرة مطلوب — تم تخطّي الصف.`);
        continue;
      }
      const startDate = cellDateIso(row["تاريخ البداية"]);
      const endDate = cellDateIso(row["تاريخ النهاية"]);
      if (startDate === undefined || endDate === undefined) {
        warnings.push(`المبادرات (صف ${row.__row}): التاريخ غير صالح (المتوقّع YYYY-MM-DD) — تم تخطّي الصف.`);
        continue;
      }
      if (startDate && endDate && endDate < startDate) {
        warnings.push(`المبادرات (صف ${row.__row}): تاريخ النهاية قبل تاريخ البداية — تم تخطّي الصف.`);
        continue;
      }
      const progress = cellNumber(row["نسبة الإنجاز %"]);
      if (progress === undefined || (progress != null && (progress < 0 || progress > 100))) {
        warnings.push(`المبادرات (صف ${row.__row}): «نسبة الإنجاز %» يجب أن تكون رقمًا بين 0 و100 — تم تخطّي الصف.`);
        continue;
      }

      // An unknown sub-goal or org unit empties that ONE field with a
      // warning; the initiative itself still imports, because losing the
      // whole row over a misspelt lookup helps nobody.
      let subGoalId: string | null = null;
      const subGoalName = cellText(row["الهدف الفرعي"]);
      if (subGoalName !== "") {
        const found = resolveUnique(subGoalsNow, subGoalName);
        if ("error" in found) {
          warnings.push(
            `المبادرات (صف ${row.__row}): الهدف الفرعي «${subGoalName}» ${found.error === "missing" ? "غير موجود" : "مكرّر"} — تُرك الحقل فارغًا.`
          );
        } else subGoalId = found.id;
      }
      let orgUnitId: string | null = null;
      const orgUnitName = cellText(row["الإدارة المالكة"]);
      if (orgUnitName !== "") {
        const found = resolveUnique(orgUnitIdsByName, orgUnitName);
        if ("error" in found) {
          warnings.push(
            `المبادرات (صف ${row.__row}): الوحدة التنظيمية «${orgUnitName}» ${found.error === "missing" ? "غير موجودة" : "مكرّرة"} — تُرك الحقل فارغًا.`
          );
        } else orgUnitId = found.id;
      }

      const statusCode = cellText(row["الحالة"]);
      const payload = {
        title_ar: titleAr,
        title_en: cellText(row["المبادرة (إنجليزي)"]) || null,
        description_ar: cellText(row["الوصف (عربي)"]) || null,
        sub_goal_id: subGoalId,
        owner_org_unit_id: orgUnitId,
        start_date: startDate,
        end_date: endDate,
        progress_percent: progress,
        // NOT NULL with a default: a blank cell must not blank out a real
        // status on an existing initiative.
        ...(statusCode === "" ? {} : { status_code: statusCode }),
      };

      const existing = initiativeIdsByTitle.get(titleAr) ?? [];
      if (existing.length > 1) {
        warnings.push(`المبادرات (صف ${row.__row}): يوجد أكثر من مبادرة بنفس الاسم — تم تخطّي الصف.`);
        continue;
      }
      if (existing.length === 1) {
        if (!mayUpdate) continue;
        const { data: saved, error } = await supabase
          .from("strategic_initiatives")
          .update(writable(payload, "initiatives"))
          .eq("id", existing[0])
          .select("id");
        if (error) warnings.push(`المبادرات (صف ${row.__row}): تعذّر التحديث (${error.code ?? "خطأ"}).`);
        else if (!saved || saved.length === 0)
          warnings.push(`المبادرات (صف ${row.__row}): لا تملك صلاحية التعديل — لم يتم التحديث.`);
        else summary.initiativesUpdated += 1;
        continue;
      }
      const { data: created, error } = await supabase
        .from("strategic_initiatives")
        .insert({ ...payload, plan_id: parsedId.data, created_by: myProfileId })
        .select("id");
      if (error) warnings.push(`المبادرات (صف ${row.__row}): تعذّر الإضافة (${error.code ?? "خطأ"}).`);
      else {
        summary.initiativesCreated += 1;
        if (created?.[0]?.id) initiativeIdsByTitle.set(titleAr, [created[0].id as string]);
      }
    }
  }

  if (!touchedAnySheet) {
    return { status: "error", message: "no_sheets" };
  }

  // Audit trail for a bulk write, same as every other import in this app.
  // Fire-and-forget: a failed audit write must not fail an import that
  // already happened.
  try {
    const admin = createAdminClient();
    await admin.from("audit_log").insert({
      actor_id: user.id,
      action: "strategic_plan_excel_imported",
      entity: "strategic_plans",
      entity_id: parsedId.data,
      after_data: { ...summary, warningCount: warnings.length },
    });
  } catch {
    // ignored on purpose
  }

  revalidatePath("/[locale]/kpis/plans/[id]", "page");
  return { status: "success", summary, warnings };
}
