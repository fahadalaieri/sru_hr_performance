import { NextRequest } from "next/server";
import { buildExportResponse, parseExportFormat, selectColumns } from "@/lib/exportResponse";
import {
  RECRUITMENT_REQUEST_EXPORT_COLUMNS,
  type RecruitmentRequestExportColumn,
} from "@/lib/recruitmentRequestExportColumns";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { requireExportAccess, type ExportGate } from "@/lib/exportAuth";
import {
  requestStatusLabel,
} from "@/lib/recruitmentWorkflow";
import {
  DEFAULT_REQUEST_SORT,
  filterRequests,
  isRequestSortOption,
  sortRequests,
} from "@/lib/recruitmentRequestTable";

// Excluded from src/proxy.ts's matcher (which skips /api entirely), so no
// locale/session-refresh happens here automatically — createClient() still
// works because Route Handlers read the request's cookies directly, same as
// Server Components/Actions. Mirrors src/app/api/employees/export/route.ts.
//
// The rows are re-fetched here through the caller's own RLS-respecting
// client; nothing about WHICH requests exist is accepted from the client.
// The screen's search/status/sort ARE accepted — as plain strings, re-applied
// server-side through the same pure helpers the table uses — so the file
// matches what the person was looking at when they pressed the button. Those
// params can only narrow the result, never widen it.
/**
 * Export gate = the permission that shows /recruitment/requests on screen (the requests area, or a finance reviewer's budget access).
 * See requireExportAccess for the product rule this encodes.
 */
const EXPORT_GATE: ExportGate = [
  { area: "recruitmentRequests", minLevel: "view" },
  { area: "recruitmentBudget", minLevel: "view" },
];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const access = await requireExportAccess(supabase, EXPORT_GATE);
  if (!access.ok) return access.response;

  const { data: requests } = await supabase
    .from("recruitment_requests")
    .select(
      "id, status, org_unit_id, job_title_id, custom_job_title, headcount, request_reason, contract_type, gender, proposed_quarter, qualifications, estimated_cost_by_requester, estimated_cost_by_hr, created_at"
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  const rows = requests ?? [];
  const orgUnitIds = [...new Set(rows.map((r) => r.org_unit_id))];
  const jobTitleIds = [...new Set(rows.map((r) => r.job_title_id).filter(Boolean))];

  const { data: orgUnits } = orgUnitIds.length
    ? await supabase.from("org_units").select("id, name_ar").in("id", orgUnitIds)
    : { data: [] };
  const { data: jobTitles } = jobTitleIds.length
    ? await supabase.from("job_titles").select("id, name_ar").in("id", jobTitleIds as string[])
    : { data: [] };

  const orgUnitName = new Map((orgUnits ?? []).map((u) => [u.id, u.name_ar]));
  const jobTitleName = new Map((jobTitles ?? []).map((j) => [j.id, j.name_ar]));

  // Arabic labels come from the same message catalogue the table renders
  // from, so the spreadsheet cannot drift from the screen. Exports are
  // Arabic-only, like every other export in this app.
  const t = await getTranslations({ locale: "ar", namespace: "RecruitmentRequestsPage" });

  const reasonKeys: Record<string, string> = {
    vacant: "reasonVacant",
    expansion: "reasonExpansion",
    replacement: "reasonReplacement",
  };
  const contractKeys: Record<string, string> = {
    permanent: "contractPermanent",
    temporary: "contractTemporary",
    part_time: "contractPartTime",
  };
  const genderKeys: Record<string, string> = {
    Male: "genderMale",
    Female: "genderFemale",
    "": "genderUnspecified",
  };

  const views = rows.map((r) => ({
    jobTitle: r.job_title_id
      ? (jobTitleName.get(r.job_title_id) ?? "")
      : (r.custom_job_title ?? ""),
    orgUnit: orgUnitName.get(r.org_unit_id) ?? "",
    headcount: r.headcount as number,
    status: r.status as string,
    qualifications: (r.qualifications ?? null) as string | null,
    createdAt: r.created_at as string,
    reason: r.request_reason as string,
    contract: r.contract_type as string,
    gender: (r.gender ?? null) as string | null,
    quarter: (r.proposed_quarter ?? null) as number | null,
    cost: (r.estimated_cost_by_hr ?? r.estimated_cost_by_requester ?? null) as number | null,
  }));

  const params = request.nextUrl.searchParams;
  const sortParam = params.get("sort") ?? "";
  const visible = sortRequests(
    filterRequests(views, {
      query: params.get("q") ?? "",
      status: params.get("status") ?? "",
    }),
    isRequestSortOption(sortParam) ? sortParam : DEFAULT_REQUEST_SORT
  );

  const columnLabels: Record<RecruitmentRequestExportColumn, string> = {
    jobTitle: t("columnJobTitle"),
    orgUnit: t("columnOrgUnit"),
    headcount: t("columnHeadcount"),
    reason: t("columnReason"),
    contract: t("columnContract"),
    gender: t("columnGender"),
    quarter: t("columnQuarter"),
    cost: t("columnCost"),
    status: t("columnStatus"),
    // Two columns the table has no room for but an export is exactly the
    // place to carry.
    qualifications: t("fieldQualifications"),
    createdAt: t("columnCreatedAt"),
  };

  const columns = selectColumns(RECRUITMENT_REQUEST_EXPORT_COLUMNS, params.get("columns"));
  const cell = (row: (typeof visible)[number], column: RecruitmentRequestExportColumn): string | number | null => {
    switch (column) {
      case "jobTitle":
        return row.jobTitle;
      case "orgUnit":
        return row.orgUnit;
      case "headcount":
        return row.headcount;
      case "reason":
        return t(reasonKeys[row.reason] ?? "reasonVacant");
      case "contract":
        return t(contractKeys[row.contract] ?? "contractPermanent");
      case "gender":
        return t(genderKeys[row.gender ?? ""] ?? "genderUnspecified");
      case "quarter":
        return row.quarter ? `Q${row.quarter}` : "";
      case "cost":
        return row.cost ?? "";
      case "status":
        return requestStatusLabel(row.status);
      case "qualifications":
        return row.qualifications ?? "";
      case "createdAt":
        return row.createdAt.slice(0, 10);
    }
  };

  return buildExportResponse({
    format: parseExportFormat(params.get("format")),
    sheetName: "طلبات الاحتياج",
    filenameBase: "recruitment-requests",
    headers: columns.map((c) => columnLabels[c]),
    rows: visible.map((row) => columns.map((c) => cell(row, c))),
    wideColumnIndexes: [columns.indexOf("qualifications")],
  });
}
