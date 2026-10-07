import { NextRequest } from "next/server";
import { buildExportResponse, parseExportFormat, selectColumns } from "@/lib/exportResponse";
import { STAFFING_EXPORT_COLUMNS, type StaffingExportColumn } from "@/lib/staffingExportColumns";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { buildDescendantOrgUnitIdsResolver } from "@/lib/orgUnitHierarchy";
import { buildEmployeeLevelOrderResolver, isBelowOrUnknownLevel } from "@/lib/orgStructureEmployeeLevel";
import { requireExportAccess, type ExportGate } from "@/lib/exportAuth";

// Excluded from src/proxy.ts's matcher (which skips /api), same shape as
// every other export route. Rows are re-fetched through the caller's own
// RLS-respecting client — org_structure_levels/positions/assignments each
// already require orgStructure/staffing>=view (20260722000004), so a caller
// who can't see the staffing screen at all simply gets an empty sheet here
// too, same posture as vacancies' own export.
//
// The "assigned" and "org-unit employees" cells reuse the exact same
// resolvers the screen itself renders from (buildDescendantOrgUnitIdsResolver,
// buildEmployeeLevelOrderResolver/isBelowOrUnknownLevel) so the exported
// file can't drift from what the table shows.
/**
 * Export gate = the permission that shows /admin/org-structure/staffing on screen (same pair org_structure_assignments_select accepts (20260725000004)).
 * See requireExportAccess for the product rule this encodes.
 */
const EXPORT_GATE: ExportGate = [
  { area: "orgStructure", minLevel: "view" },
  { area: "staffing", minLevel: "view" },
];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const access = await requireExportAccess(supabase, EXPORT_GATE);
  if (!access.ok) return access.response;

  const { data: levelsData } = await supabase
    .from("org_structure_levels")
    .select("id, name_ar, level_order")
    .is("deleted_at", null)
    .order("level_order", { ascending: true });
  const levels = (levelsData ?? []) as Array<{ id: string; name_ar: string; level_order: number }>;
  const levelNameById = new Map(levels.map((l) => [l.id, l.name_ar]));
  const levelOrderById = new Map(levels.map((l) => [l.id, l.level_order]));

  const { data: positionsData } = await supabase
    .from("org_structure_positions")
    .select("id, level_id, parent_id, name_ar, org_unit_id, job_title_id")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  const positions = (positionsData ?? []) as Array<{
    id: string;
    level_id: string;
    parent_id: string | null;
    name_ar: string;
    org_unit_id: string | null;
    job_title_id: string | null;
  }>;
  const positionNameById = new Map(positions.map((p) => [p.id, p.name_ar]));
  const positionLevelOrderById = new Map<string, number>();
  for (const p of positions) {
    const order = levelOrderById.get(p.level_id);
    if (order !== undefined) positionLevelOrderById.set(p.id, order);
  }

  const jobTitleIds = Array.from(new Set(positions.map((p) => p.job_title_id).filter((id): id is string => !!id)));
  const { data: jobTitlesData } =
    jobTitleIds.length > 0 ? await supabase.from("job_titles").select("id, name_ar").in("id", jobTitleIds) : { data: [] };
  const jobTitleNameById = new Map(((jobTitlesData ?? []) as Array<{ id: string; name_ar: string }>).map((j) => [j.id, j.name_ar]));

  const { data: orgUnitsData } = await supabase.from("org_units").select("id, name_ar, parent_id").is("deleted_at", null);
  const orgUnits = (orgUnitsData ?? []) as Array<{ id: string; name_ar: string; parent_id: string | null }>;
  const descendantOrgUnitIds = buildDescendantOrgUnitIdsResolver(orgUnits);

  const { data: assignmentsData } = await supabase
    .from("org_structure_assignments")
    .select("id, position_id, employee_id, profiles(employee_number, full_name_ar)")
    .is("deleted_at", null);
  const assignments = (assignmentsData ?? []) as unknown as Array<{
    id: string;
    position_id: string;
    employee_id: string;
    profiles: { employee_number: string; full_name_ar: string } | null;
  }>;
  const employeeLevelOrderById = buildEmployeeLevelOrderResolver(assignments, positionLevelOrderById);

  const { data: employeesData } = await supabase
    .from("profiles")
    .select("id, employee_number, full_name_ar, org_unit_id")
    .is("deleted_at", null);
  const employees = (employeesData ?? []) as Array<{
    id: string;
    employee_number: string;
    full_name_ar: string;
    org_unit_id: string | null;
  }>;
  const employeesByOrgUnitId = new Map<string, Array<{ id: string; label: string }>>();
  for (const e of employees) {
    if (!e.org_unit_id) continue;
    const list = employeesByOrgUnitId.get(e.org_unit_id) ?? [];
    list.push({ id: e.id, label: `${e.employee_number} — ${e.full_name_ar}` });
    employeesByOrgUnitId.set(e.org_unit_id, list);
  }

  const rows = positions.map((position) => ({
    level: levelNameById.get(position.level_id) ?? "—",
    parentName: position.parent_id ? positionNameById.get(position.parent_id) ?? "—" : null,
    position: position.name_ar,
    jobTitle: position.job_title_id ? jobTitleNameById.get(position.job_title_id) ?? "" : "",
    assigned: assignments
      .filter((a) => a.position_id === position.id)
      .map((a) => (a.profiles ? `${a.profiles.employee_number} — ${a.profiles.full_name_ar}` : "—")),
    orgUnitEmployees: position.org_unit_id
      ? Array.from(descendantOrgUnitIds(position.org_unit_id))
          .flatMap((id) => employeesByOrgUnitId.get(id) ?? [])
          .filter((e) => isBelowOrUnknownLevel(e.id, positionLevelOrderById.get(position.id), employeeLevelOrderById))
          .map((e) => e.label)
      : [],
  }));

  const t = await getTranslations({ locale: "ar", namespace: "OrgStructureStaffingPage" });
  const columnLabels: Record<StaffingExportColumn, string> = {
    level: t("positionColumnLevel"),
    parent: t("positionColumnParent"),
    position: t("positionColumnName"),
    jobTitle: t("positionColumnJobTitle"),
    assigned: t("positionColumnAssigned"),
    orgUnitEmployees: t("positionColumnOrgUnitEmployees"),
  };

  const columns = selectColumns(STAFFING_EXPORT_COLUMNS, request.nextUrl.searchParams.get("columns"));
  const cell = (row: (typeof rows)[number], column: StaffingExportColumn): string | number | null => {
    switch (column) {
      case "level":
        return row.level;
      case "parent":
        return row.parentName ?? t("rootChip");
      case "position":
        return row.position;
      case "jobTitle":
        return row.jobTitle;
      case "assigned":
        return row.assigned.join("، ");
      case "orgUnitEmployees":
        return row.orgUnitEmployees.join("، ");
    }
  };

  return buildExportResponse({
    format: parseExportFormat(request.nextUrl.searchParams.get("format")),
    sheetName: "تسكين الموظفين",
    filenameBase: "org-structure-staffing",
    headers: columns.map((c) => columnLabels[c]),
    rows: rows.map((row) => columns.map((c) => cell(row, c))),
    columnWidth: 20,
    wideColumnIndexes: [columns.indexOf("assigned"), columns.indexOf("orgUnitEmployees")],
  });
}
