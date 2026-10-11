import ExcelJS from "exceljs";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireExportAccess, type ExportGate } from "@/lib/exportAuth";
import {
  DEFAULT_EMPLOYEE_EXPORT_COLUMNS,
  isEmployeeExportColumn,
  type EmployeeExportColumn,
} from "@/lib/employeeExportColumns";

// Excluded from src/proxy.ts's matcher (which skips /api entirely), so no
// locale/session-refresh happens here automatically — createClient() still
// works because Route Handlers can read the request's cookies directly,
// same as Server Components/Actions (see src/lib/supabase/server.ts).
//
// Deliberately re-runs the exact same RLS-respecting query the /employees
// page itself uses rather than accepting any row data from the client —
// an export must reflect exactly what this caller is currently authorized
// to see, not whatever happened to be rendered in their browser.
/**
 * Export gate = the permission that shows /employees on screen (no permission gate of its own: profiles_select's RLS decides (self row, subordinates, employeeData scope)).
 * See requireExportAccess for the product rule this encodes.
 */
const EXPORT_GATE: ExportGate = [];

export async function GET(request: NextRequest) {
  const format = request.nextUrl.searchParams.get("format");
  if (format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }

  // 2026-07-25: "عند التصدير يطلع شاشة على شكل checkboxes لتحديد الخانات
  // التي تحتاج تصديرها من كامل النموذج وليس المعروض فقط" — an explicit
  // `columns` param (comma-separated) picks which fields to include, from
  // the full set the add/edit forms know about, not just the 6 the table
  // shows. Falls back to that original 6-column default when absent, so
  // existing bookmarked export links keep working unchanged.
  const columnsParam = request.nextUrl.searchParams.get("columns");
  const requestedColumns: EmployeeExportColumn[] = columnsParam
    ? columnsParam.split(",").filter(isEmployeeExportColumn)
    : DEFAULT_EMPLOYEE_EXPORT_COLUMNS;
  const columns = requestedColumns.length > 0 ? requestedColumns : DEFAULT_EMPLOYEE_EXPORT_COLUMNS;

  const supabase = await createClient();
  const access = await requireExportAccess(supabase, EXPORT_GATE);
  if (!access.ok) return access.response;

  const { data } = await supabase
    .from("profiles")
    .select(
      "id, employee_number, full_name_ar, full_name_en, email, username, status, approval_status, auth_user_id, hire_date, date_of_birth, qualification, education_speciality, mobile, marital_status, gender, nationality, employee_category, insurance_category, org_units(name_ar), job_titles(name_ar)"
    )
    .is("deleted_at", null)
    .order("employee_number");

  const employees = (data ?? []) as unknown as Array<{
    id: string;
    employee_number: string;
    full_name_ar: string;
    full_name_en: string | null;
    email: string | null;
    username: string | null;
    status: string;
    approval_status: string;
    auth_user_id: string | null;
    hire_date: string | null;
    date_of_birth: string | null;
    qualification: string | null;
    education_speciality: string | null;
    mobile: string | null;
    marital_status: string | null;
    gender: string | null;
    nationality: string | null;
    employee_category: string | null;
    insurance_category: string | null;
    org_units: { name_ar: string } | null;
    job_titles: { name_ar: string } | null;
  }>;

  const authUserIds = employees.map((e) => e.auth_user_id).filter((id): id is string => !!id);
  const pendingProfileIds = employees.filter((e) => !e.auth_user_id).map((e) => e.id);

  const [{ data: userRolesData }, { data: pendingRolesData }] = await Promise.all([
    authUserIds.length > 0
      ? supabase.from("user_roles").select("user_id, roles(name_ar)").in("user_id", authUserIds)
      : Promise.resolve({ data: [] as { user_id: string; roles: { name_ar: string } | null }[] }),
    pendingProfileIds.length > 0
      ? supabase.from("pending_role_assignments").select("profile_id, roles(name_ar)").in("profile_id", pendingProfileIds)
      : Promise.resolve({ data: [] as { profile_id: string; roles: { name_ar: string } | null }[] }),
  ]);

  const rolesByAuthUserId = new Map<string, string[]>();
  for (const row of (userRolesData ?? []) as unknown as { user_id: string; roles: { name_ar: string } | null }[]) {
    if (!row.roles) continue;
    const list = rolesByAuthUserId.get(row.user_id) ?? [];
    list.push(row.roles.name_ar);
    rolesByAuthUserId.set(row.user_id, list);
  }
  const pendingRolesByProfileId = new Map<string, string[]>();
  for (const row of (pendingRolesData ?? []) as unknown as { profile_id: string; roles: { name_ar: string } | null }[]) {
    if (!row.roles) continue;
    const list = pendingRolesByProfileId.get(row.profile_id) ?? [];
    list.push(row.roles.name_ar);
    pendingRolesByProfileId.set(row.profile_id, list);
  }

  const statusLabels: Record<string, string> = { active: "نشط", on_leave: "في إجازة", terminated: "منتهي الخدمة" };
  const approvalStatusLabels: Record<string, string> = { pending: "بانتظار الاعتماد", approved: "معتمد", rejected: "مرفوض" };
  const columnLabels: Record<EmployeeExportColumn, string> = {
    employeeNumber: "الرقم الوظيفي",
    fullNameAr: "الاسم (عربي)",
    fullNameEn: "الاسم (إنجليزي)",
    email: "البريد الإلكتروني",
    username: "اسم المستخدم",
    orgUnit: "الوحدة التنظيمية",
    jobTitle: "المسمى الوظيفي",
    role: "الدور في النظام",
    status: "الحالة",
    account: "حساب الدخول",
    approvalStatus: "حالة الاعتماد",
    hireDate: "تاريخ التعيين",
    dateOfBirth: "تاريخ الميلاد",
    qualification: "المؤهل العلمي",
    educationSpeciality: "التخصص",
    mobile: "الجوال",
    maritalStatus: "الحالة الاجتماعية",
    gender: "الجنس",
    nationality: "الجنسية",
    employeeCategory: "فئة الموظف",
    insuranceCategory: "فئة التأمين",
  };

  function cellValue(e: (typeof employees)[number], column: EmployeeExportColumn): string {
    switch (column) {
      case "employeeNumber":
        return e.employee_number;
      case "fullNameAr":
        return e.full_name_ar;
      case "fullNameEn":
        return e.full_name_en ?? "";
      case "email":
        return e.email ?? "";
      case "username":
        return e.username ?? "";
      case "orgUnit":
        return e.org_units?.name_ar ?? "";
      case "jobTitle":
        return e.job_titles?.name_ar ?? "";
      case "role": {
        const roleList = e.auth_user_id ? rolesByAuthUserId.get(e.auth_user_id) : pendingRolesByProfileId.get(e.id);
        const roleLabel = roleList && roleList.length > 0 ? roleList.join("، ") : "بلا دور";
        return e.auth_user_id ? roleLabel : `${roleLabel} (بانتظار قبول الدعوة)`;
      }
      case "status":
        return statusLabels[e.status] ?? e.status;
      case "account":
        return e.auth_user_id ? "مُفعَّل" : "بانتظار قبول الدعوة";
      case "approvalStatus":
        return approvalStatusLabels[e.approval_status] ?? e.approval_status;
      case "hireDate":
        return e.hire_date ?? "";
      case "dateOfBirth":
        return e.date_of_birth ?? "";
      case "qualification":
        return e.qualification ?? "";
      case "educationSpeciality":
        return e.education_speciality ?? "";
      case "mobile":
        return e.mobile ?? "";
      case "maritalStatus":
        return e.marital_status ?? "";
      case "gender":
        return e.gender ?? "";
      case "nationality":
        return e.nationality ?? "";
      case "employeeCategory":
        return e.employee_category ?? "";
      case "insuranceCategory":
        return e.insurance_category ?? "";
    }
  }

  const headers = columns.map((c) => columnLabels[c]);
  const rows = employees.map((e) => columns.map((c) => cellValue(e, c)));

  if (format === "csv") {
    const csvEscape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const lines = [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
    const csv = "﻿" + lines.join("\r\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="employees.csv"`,
      },
    });
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("الموظفون");
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const r of rows) {
    sheet.addRow(r);
  }
  sheet.columns.forEach((col) => {
    col.width = 24;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="employees.xlsx"`,
    },
  });
}
