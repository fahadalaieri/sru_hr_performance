import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { buildExportResponse, parseExportFormat, selectColumns } from "@/lib/exportResponse";
import { EVALUATION_RESULT_EXPORT_COLUMNS, type EvaluationResultExportColumn } from "@/lib/evaluationResultExportColumns";
import { createClient } from "@/lib/supabase/server";
import { hasVpraAccess } from "@/lib/vpra";
import { resolveEvaluationResultsForCycle } from "@/lib/evaluationResult";
import type { MethodWeights } from "@/lib/evaluationCycle";
import { requireExportAccess, type ExportGate } from "@/lib/exportAuth";
import {
  DEFAULT_EVALUATION_RESULT_SORT,
  filterEvaluationResults,
  isEvaluationResultSortOption,
  sortEvaluationResults,
} from "@/lib/evaluationResultTable";

// Excluded from src/proxy.ts's matcher (which skips /api entirely) -- same
// shape as every other export route in this app (e.g.
// src/app/api/recruitment/requests/export/route.ts): createClient() still
// works here since Route Handlers read the request's cookies directly.
//
// Rows are re-fetched here through the caller's own RLS-respecting client,
// via the SAME resolveEvaluationResultsForCycle/dual-access-path logic the
// page uses -- nothing about WHICH employees appear is accepted from the
// client. The screen's search/band/sort ARE accepted as plain strings and
// re-applied server-side through the same pure helpers the table uses, so
// the file matches what was on screen when the button was pressed -- these
// params can only narrow the result, never widen it.
/**
 * Export gate = the permission that shows /evaluation-results on screen (custom rule below: evaluationResultsReports>=view OR the caller has direct reports).
 * See requireExportAccess for the product rule this encodes.
 */
const EXPORT_GATE: ExportGate = [];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const access = await requireExportAccess(supabase, EXPORT_GATE);
  if (!access.ok) return access.response;

  const params = request.nextUrl.searchParams;
  const cycleId = params.get("cycleId");
  if (!cycleId) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const { data: cycle } = await supabase
    .from("evaluation_cycles")
    .select("id, name_ar, weight_activities, weight_competencies, weight_bau, weight_feedback_360")
    .eq("id", cycleId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!cycle) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const permissions = access.permissions;
  const canViewBroad = hasVpraAccess(permissions.evaluationResultsReports ?? "none", "view");

  const { data: myProfile } = await supabase.from("profiles").select("id").eq("auth_user_id", access.userId).maybeSingle();
  const { data: reportsData } = myProfile
    ? await supabase.from("profiles").select("id").eq("supervisor_id", myProfile.id).is("deleted_at", null)
    : { data: null };
  const teamEmployeeIds = (reportsData ?? []).map((row) => row.id);
  const hasTeam = teamEmployeeIds.length > 0;
  if (!canViewBroad && !hasTeam) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const cycleWeights: MethodWeights = {
    activities: Number(cycle.weight_activities),
    competencies: Number(cycle.weight_competencies),
    bau: Number(cycle.weight_bau),
    feedback360: Number(cycle.weight_feedback_360),
  };
  const results = canViewBroad
    ? await resolveEvaluationResultsForCycle(supabase, cycle.id, cycleWeights)
    : await resolveEvaluationResultsForCycle(supabase, cycle.id, cycleWeights, { employeeIds: teamEmployeeIds });

  const views = results.map((result) => ({
    employeeNumber: result.employeeNumber,
    employeeName: result.employeeName,
    orgUnitName: result.orgUnitName,
    score: result.score,
    bandId: result.band?.id ?? null,
    bandLabel: result.band?.labelAr ?? null,
    methodScores: result.methodScores,
  }));

  const sortParam = params.get("sort") ?? "";
  const visible = sortEvaluationResults(
    filterEvaluationResults(views, { query: params.get("q") ?? "", bandId: params.get("band") ?? "" }),
    isEvaluationResultSortOption(sortParam) ? sortParam : DEFAULT_EVALUATION_RESULT_SORT
  );

  // Arabic labels come from the same message catalogue the table renders
  // from, so the spreadsheet cannot drift from the screen -- exports are
  // Arabic-only, like every other export in this app.
  const t = await getTranslations({ locale: "ar", namespace: "EvaluationResultsEmployeesPage" });
  const tDashboard = await getTranslations({ locale: "ar", namespace: "EvaluationResultsDashboardPage" });

  const columnLabels: Record<EvaluationResultExportColumn, string> = {
    employeeNumber: t("columnEmployeeNumber"),
    employeeName: t("columnEmployeeName"),
    orgUnit: t("columnOrgUnit"),
    score: t("columnScore"),
    band: t("columnBand"),
    activities: tDashboard("methodActivities"),
    competencies: tDashboard("methodCompetencies"),
    bau: tDashboard("methodBau"),
    feedback360: tDashboard("method360"),
  };

  const columns = selectColumns(EVALUATION_RESULT_EXPORT_COLUMNS, params.get("columns"));
  const cell = (row: (typeof visible)[number], column: EvaluationResultExportColumn): string | number | null => {
    switch (column) {
      case "employeeNumber":
        return row.employeeNumber;
      case "employeeName":
        return row.employeeName;
      case "orgUnit":
        return row.orgUnitName;
      case "score":
        return row.score != null ? Math.round(row.score * 10) / 10 : null;
      case "band":
        return row.bandLabel;
      case "activities":
      case "competencies":
      case "bau":
      case "feedback360": {
        const value = row.methodScores[column];
        return value != null ? Math.round(value * 10) / 10 : null;
      }
    }
  };

  return buildExportResponse({
    format: parseExportFormat(params.get("format")),
    sheetName: "نتائج التقييم",
    filenameBase: "evaluation-results",
    headers: columns.map((c) => columnLabels[c]),
    rows: visible.map((row) => columns.map((c) => cell(row, c))),
  });
}
