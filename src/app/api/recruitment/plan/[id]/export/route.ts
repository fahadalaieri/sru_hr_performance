import ExcelJS from "exceljs";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeRecruitmentPlanTotals } from "@/lib/recruitmentPlan";
import { planStatusLabelFor } from "@/lib/recruitmentWorkflow";
import { contractTypeLabel, quarterLabel } from "@/lib/recruitmentPlanAnalytics";
import { requireExportAccess, type ExportGate } from "@/lib/exportAuth";

// Excluded from src/proxy.ts's matcher (which skips /api entirely), so no
// locale/session refresh runs here — createClient() still works because Route
// Handlers read the request's cookies directly, same as Server Components.
// Placed under /api rather than [locale]/ for exactly that reason, matching
// the employees export route this follows.
//
// Every row is re-read here through the caller's own RLS-respecting client:
// an export must reflect what THIS caller is authorized to see right now, not
// whatever their browser happens to have rendered. Nothing is accepted from
// the client except the plan id and the format.

/** Every field the plan's items carry, per the spec's "بجميع الحقول". */
const HEADERS = [
  "#",
  "المسمى الوظيفي",
  "الدرجة",
  "الوحدة التنظيمية",
  "المنصب في الهيكل",
  "العدد",
  "الربع المستهدف",
  "الأولوية",
  "نوع التعاقد",
  "التكلفة الشهرية للوظيفة",
  "التكلفة الشهرية الإجمالية",
  "التكلفة السنوية الإجمالية",
  "الحالة",
  "المبرر",
  "مصدر البند",
  "رقم الشاغر المنشور",
];

const priorityLabels: Record<string, string> = {
  high: "عالية",
  medium: "متوسطة",
  low: "منخفضة",
};

/**
 * Export gate = the permission that shows /recruitment/plan/[id] on screen (the page's own canView: plan viewers, or finance reviewing the budget).
 * See requireExportAccess for the product rule this encodes.
 */
const EXPORT_GATE: ExportGate = [
  { area: "recruitmentPlan", minLevel: "view" },
  { area: "recruitmentBudget", minLevel: "recommend" },
];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const format = request.nextUrl.searchParams.get("format");
  if (format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }

  const supabase = await createClient();
  const access = await requireExportAccess(supabase, EXPORT_GATE);
  if (!access.ok) return access.response;

  const { data: plan } = await supabase
    .from("recruitment_plans")
    .select("id, name_ar, plan_year, status, approved_budget, hr_recommendation, finance_note, finance_reviewed_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  // RLS returning nothing is indistinguishable from "no such plan", and both
  // deserve the same answer — telling an unauthorized caller that a plan
  // exists would itself be a leak.
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: itemData } = await supabase
    .from("recruitment_plan_items")
    .select(
      "id, headcount, target_quarter, priority, estimated_monthly_cost, justification, status, vacancy_id, request_id, org_units(name_ar), job_titles(name_ar, grade_level), org_structure_positions(name_ar)"
    )
    .eq("plan_id", id)
    .is("deleted_at", null)
    .order("created_at");

  const items = (itemData ?? []) as unknown as Array<{
    id: string;
    headcount: number;
    target_quarter: number | null;
    priority: string | null;
    estimated_monthly_cost: number | null;
    justification: string | null;
    status: string;
    vacancy_id: string | null;
    request_id: string | null;
    org_units: { name_ar: string } | null;
    job_titles: { name_ar: string; grade_level: number } | null;
    org_structure_positions: { name_ar: string } | null;
  }>;

  // Contract type lives on the request, not the item — same join the
  // dashboard makes, so the export and the screen agree.
  const requestIds = items.map((i) => i.request_id).filter(Boolean) as string[];
  const { data: linkedRequests } = requestIds.length
    ? await supabase.from("recruitment_requests").select("id, contract_type").in("id", requestIds)
    : { data: [] };
  const contractByRequest = new Map((linkedRequests ?? []).map((r) => [r.id, r.contract_type]));

  const rows = items.map((item, index) => {
    const monthlyEach = item.estimated_monthly_cost;
    const monthlyTotal = monthlyEach === null ? null : monthlyEach * item.headcount;
    return [
      index + 1,
      item.job_titles?.name_ar ?? "",
      item.job_titles?.grade_level ?? "",
      item.org_units?.name_ar ?? "",
      item.org_structure_positions?.name_ar ?? "",
      item.headcount,
      quarterLabel(item.target_quarter),
      item.priority ? (priorityLabels[item.priority] ?? item.priority) : "",
      contractTypeLabel(item.request_id ? (contractByRequest.get(item.request_id) ?? null) : null),
      monthlyEach ?? "",
      monthlyTotal ?? "",
      monthlyTotal === null ? "" : monthlyTotal * 12,
      item.status,
      item.justification ?? "",
      // Provenance: a demand request from a department, or pulled from the
      // org chart. Worth exporting — it is the one thing the row itself
      // cannot otherwise tell a reader.
      item.request_id ? "طلب احتياج" : "الهيكل التنظيمي",
      item.vacancy_id ? "نعم" : "",
    ];
  });

  const totals = computeRecruitmentPlanTotals(
    items.map((i) => ({ headcount: i.headcount, estimatedMonthlyCost: i.estimated_monthly_cost }))
  );

  const fileBase = `recruitment-plan-${plan.plan_year}`;

  if (format === "csv") {
    const escape = (value: unknown) => {
      const text = String(value ?? "");
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [HEADERS, ...rows].map((row) => row.map(escape).join(","));
    // UTF-8 BOM so Excel opens the Arabic correctly instead of mojibake —
    // the same reason the employees CSV export prefixes one.
    const body = `﻿${lines.join("\r\n")}\r\n`;
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileBase}.csv"`,
      },
    });
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("بنود الخطة", { views: [{ rightToLeft: true }] });

  sheet.addRow([`خطة التوظيف ${plan.plan_year} — ${plan.name_ar}`]);
  sheet.addRow([`الحالة: ${planStatusLabelFor(plan.status, { financeReviewed: plan.finance_reviewed_at !== null })}`]);
  sheet.addRow([
    `إجمالي الوظائف: ${totals.totalHeadcount}`,
    `التكلفة السنوية: ${totals.totalAnnualCost}`,
    plan.approved_budget === null ? "الميزانية المعتمدة: غير مسجّلة" : `الميزانية المعتمدة: ${plan.approved_budget}`,
  ]);
  sheet.addRow([]);

  const headerRow = sheet.addRow(HEADERS);
  headerRow.font = { bold: true };
  for (const row of rows) sheet.addRow(row);

  sheet.columns.forEach((column) => {
    column.width = 20;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileBase}.xlsx"`,
    },
  });
}
