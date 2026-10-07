import ExcelJS from "exceljs";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { STRATEGIC_PLAN_COLUMNS, STRATEGIC_PLAN_SHEETS } from "@/lib/strategicPlanExcel";
import { buildExportResponse, parseExportFormat } from "@/lib/exportResponse";
import { requireExportAccess, type ExportGate } from "@/lib/exportAuth";

// Excluded from src/proxy.ts's matcher (which skips /api entirely), so no
// locale/session-refresh happens here — createClient() still works because
// Route Handlers read the request's cookies directly, same as Server
// Components (see src/app/api/employees/export/route.ts, the precedent
// this follows).
//
// Every query below runs through the CALLER's own RLS-respecting client and
// re-derives the data from the database rather than accepting anything from
// the browser: the workbook reflects exactly what this caller is authorized
// to see right now. A caller who can read nothing gets a valid workbook
// with headers and no rows, not an error.
/**
 * Export gate = the permission that shows /kpis/plans/[id] on screen (deliberately ungated page (20260801000001); nested goal/KPI tables keep their own RLS).
 * See requireExportAccess for the product rule this encodes.
 */
const EXPORT_GATE: ExportGate = [];

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const access = await requireExportAccess(supabase, EXPORT_GATE);
  if (!access.ok) return access.response;

  const { data: plan } = await supabase
    .from("strategic_plans")
    .select("id, name_ar, start_year, end_year")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!plan) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // ---- Global (not plan-scoped): vision/mission/values ----
  const { data: identity } = await supabase
    .from("strategic_identity")
    .select("vision_ar, vision_en, mission_ar, mission_en")
    .maybeSingle();
  const { data: valuesData } = await supabase
    .from("strategic_values")
    .select("title_ar, title_en, description_ar, description_en, display_order")
    .is("deleted_at", null)
    .order("display_order", { ascending: true });

  // ---- This plan's goals -> sub-goals -> KPIs -> annual targets ----
  const { data: goalsData } = await supabase
    .from("strategic_goals")
    .select("id, title_ar, title_en, description_ar, description_en, weight")
    .eq("plan_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  const goals = (goalsData ?? []) as Array<{
    id: string;
    title_ar: string;
    title_en: string | null;
    description_ar: string | null;
    description_en: string | null;
    weight: number | null;
  }>;
  const goalIds = new Set(goals.map((g) => g.id));
  const goalTitleById = new Map(goals.map((g) => [g.id, g.title_ar]));

  const { data: subGoalsData } = await supabase
    .from("sub_goals")
    .select(
      "id, strategic_goal_id, owner_position_id, title_ar, title_en, description_ar, description_en, weight"
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  const subGoals = (
    (subGoalsData ?? []) as Array<{
      id: string;
      strategic_goal_id: string;
      owner_position_id: string;
      title_ar: string;
      title_en: string | null;
      description_ar: string | null;
      description_en: string | null;
      weight: number | null;
    }>
  ).filter((sg) => goalIds.has(sg.strategic_goal_id));
  const subGoalIds = new Set(subGoals.map((sg) => sg.id));
  const subGoalById = new Map(subGoals.map((sg) => [sg.id, sg]));

  const { data: kpisData } = await supabase
    .from("strategic_kpis")
    .select("id, strategic_goal_id, sub_goal_id, title_ar, title_en, unit_ar, plan_target_value, weight")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  const kpis = (
    (kpisData ?? []) as Array<{
      id: string;
      strategic_goal_id: string | null;
      sub_goal_id: string | null;
      title_ar: string;
      title_en: string | null;
      unit_ar: string;
      plan_target_value: number | null;
      weight: number | null;
    }>
  ).filter(
    (k) =>
      (k.strategic_goal_id != null && goalIds.has(k.strategic_goal_id)) ||
      (k.sub_goal_id != null && subGoalIds.has(k.sub_goal_id))
  );
  const kpiById = new Map(kpis.map((k) => [k.id, k]));

  const { data: annualData } = await supabase
    .from("kpi_annual_targets")
    .select("kpi_id, cycle_id, target_value, actual_value")
    .is("deleted_at", null);
  const annualTargets = (
    (annualData ?? []) as Array<{
      kpi_id: string;
      cycle_id: string;
      target_value: number;
      actual_value: number | null;
    }>
  ).filter((a) => kpiById.has(a.kpi_id));

  const { data: targetsData } = await supabase
    .from("targets")
    .select("sub_goal_id, assigned_position_id, assigned_employee_id, title_ar, unit_ar, target_value, actual_value, weight, status")
    .is("deleted_at", null);
  const assignedTargets = (
    (targetsData ?? []) as Array<{
      sub_goal_id: string;
      assigned_position_id: string | null;
      assigned_employee_id: string | null;
      title_ar: string;
      unit_ar: string;
      target_value: number;
      actual_value: number | null;
      weight: number | null;
      status: string;
    }>
  ).filter((tg) => subGoalIds.has(tg.sub_goal_id));

  // Read through the caller's own client like everything else here, so a
  // committee member exports exactly the programs they can already see.
  const { data: programsData } = await supabase
    .from("strategic_programs")
    .select("name_ar, name_en, description_ar, status, start_date, end_date")
    .eq("plan_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  const programs = (programsData ?? []) as Array<{
    name_ar: string;
    name_en: string | null;
    description_ar: string | null;
    status: string;
    start_date: string | null;
    end_date: string | null;
  }>;

  const { data: initiativesData } = await supabase
    .from("strategic_initiatives")
    .select("title_ar, title_en, description_ar, sub_goal_id, owner_org_unit_id, status_code, progress_percent, start_date, end_date")
    .eq("plan_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  const initiatives = (initiativesData ?? []) as Array<{
    title_ar: string;
    title_en: string | null;
    description_ar: string | null;
    sub_goal_id: string | null;
    owner_org_unit_id: string | null;
    status_code: string;
    progress_percent: number | string | null;
    start_date: string | null;
    end_date: string | null;
  }>;

  // Names for the initiative sheet's two foreign keys. Both are read
  // through the caller's own client, so a cell is empty when the reader
  // cannot see the referenced row rather than leaking its name.
  const initiativeOrgUnitIds = Array.from(
    new Set(initiatives.map((i) => i.owner_org_unit_id).filter((v): v is string => v != null))
  );
  const { data: initiativeOrgUnits } =
    initiativeOrgUnitIds.length > 0
      ? await supabase.from("org_units").select("id, name_ar").in("id", initiativeOrgUnitIds)
      : { data: [] };
  const orgUnitNameById = new Map(
    ((initiativeOrgUnits ?? []) as Array<{ id: string; name_ar: string }>).map((u) => [u.id, u.name_ar])
  );

  // ---- Name lookups: cycles, positions, employees ----
  const { data: cyclesData } = await supabase.from("evaluation_cycles").select("id, name_ar").is("deleted_at", null);
  const cycleNameById = new Map(((cyclesData ?? []) as Array<{ id: string; name_ar: string }>).map((c) => [c.id, c.name_ar]));

  // list_org_structure_positions(): the SECURITY DEFINER RPC the plan page
  // itself uses — org_structure_positions_select's own RLS doesn't cover
  // every role that can reach this export.
  const { data: positions } = await supabase.rpc("list_org_structure_positions");
  const positionNameById = new Map(((positions ?? []) as Array<{ id: string; name_ar: string }>).map((p) => [p.id, p.name_ar]));

  const employeeIds = Array.from(
    new Set(assignedTargets.map((tg) => tg.assigned_employee_id).filter((v): v is string => v != null))
  );
  const { data: employeesData } =
    employeeIds.length > 0 ? await supabase.from("profiles").select("id, full_name_ar").in("id", employeeIds) : { data: [] };
  const employeeNameById = new Map(
    ((employeesData ?? []) as Array<{ id: string; full_name_ar: string }>).map((p) => [p.id, p.full_name_ar])
  );

  const workbook = new ExcelJS.Workbook();
  // Which sheets the caller asked for. Absent means all of them, so a link
  // written before the picker existed still returns the whole workbook.
  const requestedSheets = request.nextUrl.searchParams.get("sheets");
  const wantedSheets = requestedSheets
    ? new Set(requestedSheets.split(",").map((v: string) => v.trim()).filter(Boolean))
    : null;
  const format = parseExportFormat(request.nextUrl.searchParams.get("format"));

  // A CSV holds ONE table. Rather than inventing a way to staple nine sheets
  // into one file, CSV exports exactly the sheet asked for (the UI asks for
  // one), and the sheets are collected here so either format can use them.
  const collected: Array<{ key: string; name: string; columns: readonly string[]; rows: Array<Array<string | number | null>> }> = [];

  function addSheet(name: string, columns: readonly string[], rows: Array<Array<string | number | null>>) {
    const key = (Object.keys(STRATEGIC_PLAN_SHEETS) as Array<keyof typeof STRATEGIC_PLAN_SHEETS>).find(
      (k) => STRATEGIC_PLAN_SHEETS[k] === name
    );
    if (wantedSheets && (!key || !wantedSheets.has(key))) return;
    collected.push({ key: key ?? name, name, columns, rows });
    if (format === "csv") return;
    const sheet = workbook.addWorksheet(name, { views: [{ rightToLeft: true }] });
    sheet.addRow([...columns]);
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) sheet.addRow(row);
    sheet.columns.forEach((col) => {
      col.width = 26;
    });
  }

  addSheet(STRATEGIC_PLAN_SHEETS.identity, STRATEGIC_PLAN_COLUMNS.identity, [
    [identity?.vision_ar ?? "", identity?.vision_en ?? "", identity?.mission_ar ?? "", identity?.mission_en ?? ""],
  ]);

  addSheet(
    STRATEGIC_PLAN_SHEETS.values,
    STRATEGIC_PLAN_COLUMNS.values,
    (
      (valuesData ?? []) as Array<{
        title_ar: string;
        title_en: string | null;
        description_ar: string | null;
        description_en: string | null;
        display_order: number;
      }>
    ).map((v) => [v.title_ar, v.title_en ?? "", v.description_ar ?? "", v.description_en ?? "", v.display_order])
  );

  addSheet(
    STRATEGIC_PLAN_SHEETS.goals,
    STRATEGIC_PLAN_COLUMNS.goals,
    goals.map((g) => [g.title_ar, g.title_en ?? "", g.description_ar ?? "", g.description_en ?? "", g.weight])
  );

  addSheet(
    STRATEGIC_PLAN_SHEETS.subGoals,
    STRATEGIC_PLAN_COLUMNS.subGoals,
    subGoals.map((sg) => [
      goalTitleById.get(sg.strategic_goal_id) ?? "",
      sg.title_ar,
      sg.title_en ?? "",
      sg.description_ar ?? "",
      sg.description_en ?? "",
      positionNameById.get(sg.owner_position_id) ?? "",
      sg.weight,
    ])
  );

  function kpiParentTitles(k: { strategic_goal_id: string | null; sub_goal_id: string | null }): [string, string] {
    if (k.strategic_goal_id) return [goalTitleById.get(k.strategic_goal_id) ?? "", ""];
    const sub = k.sub_goal_id ? subGoalById.get(k.sub_goal_id) : undefined;
    if (!sub) return ["", ""];
    return [goalTitleById.get(sub.strategic_goal_id) ?? "", sub.title_ar];
  }

  addSheet(
    STRATEGIC_PLAN_SHEETS.kpis,
    STRATEGIC_PLAN_COLUMNS.kpis,
    kpis.map((k) => {
      const [goalTitle, subGoalTitle] = kpiParentTitles(k);
      return [goalTitle, subGoalTitle, k.title_ar, k.title_en ?? "", k.unit_ar, k.plan_target_value, k.weight];
    })
  );

  addSheet(
    STRATEGIC_PLAN_SHEETS.annualTargets,
    STRATEGIC_PLAN_COLUMNS.annualTargets,
    annualTargets.map((a) => {
      const k = kpiById.get(a.kpi_id)!;
      const [goalTitle, subGoalTitle] = kpiParentTitles(k);
      return [goalTitle, subGoalTitle, k.title_ar, cycleNameById.get(a.cycle_id) ?? "", a.target_value, a.actual_value];
    })
  );

  addSheet(
    STRATEGIC_PLAN_SHEETS.assignedTargets,
    STRATEGIC_PLAN_COLUMNS.assignedTargets,
    assignedTargets.map((tg) => {
      const sub = subGoalById.get(tg.sub_goal_id);
      return [
        sub ? goalTitleById.get(sub.strategic_goal_id) ?? "" : "",
        sub?.title_ar ?? "",
        tg.title_ar,
        tg.assigned_position_id ? positionNameById.get(tg.assigned_position_id) ?? "" : "",
        tg.assigned_employee_id ? employeeNameById.get(tg.assigned_employee_id) ?? "" : "",
        tg.unit_ar,
        tg.target_value,
        tg.actual_value,
        tg.weight,
        tg.status,
      ];
    })
  );

  addSheet(
    STRATEGIC_PLAN_SHEETS.programs,
    STRATEGIC_PLAN_COLUMNS.programs,
    programs.map((p) => [p.name_ar, p.name_en ?? "", p.description_ar ?? "", p.status, p.start_date ?? "", p.end_date ?? ""])
  );

  addSheet(
    STRATEGIC_PLAN_SHEETS.initiatives,
    STRATEGIC_PLAN_COLUMNS.initiatives,
    initiatives.map((i) => [
      i.title_ar,
      i.title_en ?? "",
      i.description_ar ?? "",
      i.sub_goal_id ? subGoalById.get(i.sub_goal_id)?.title_ar ?? "" : "",
      i.owner_org_unit_id ? orgUnitNameById.get(i.owner_org_unit_id) ?? "" : "",
      i.status_code,
      i.progress_percent == null ? "" : Number(i.progress_percent),
      i.start_date ?? "",
      i.end_date ?? "",
    ])
  );

  if (format === "csv") {
    // Exactly one sheet, so the file is a real table. With none selected
    // there is nothing to write, which is an error rather than an empty file
    // that looks like "no data".
    const sheet = collected[0];
    if (!sheet) {
      return NextResponse.json({ error: "no_sheet_selected" }, { status: 400 });
    }
    return buildExportResponse({
      format: "csv",
      sheetName: sheet.name,
      filenameBase: `strategic-plan-${sheet.key}`,
      headers: [...sheet.columns],
      rows: sheet.rows,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  // RFC 5987 filename*: the plan name is Arabic, which a bare filename=
  // mangles in most browsers.
  const safeName = encodeURIComponent(`${plan.name_ar} ${plan.start_year}-${plan.end_year}.xlsx`);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="strategic-plan.xlsx"; filename*=UTF-8''${safeName}`,
    },
  });
}
