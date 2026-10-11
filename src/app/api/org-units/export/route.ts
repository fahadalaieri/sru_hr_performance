import { NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { buildExportResponse, parseExportFormat, selectColumns } from "@/lib/exportResponse";
import { ORG_UNIT_EXPORT_COLUMNS, type OrgUnitExportColumn } from "@/lib/orgUnitExportColumns";
import { createClient } from "@/lib/supabase/server";
import { requireExportAccess, type ExportGate } from "@/lib/exportAuth";

// Excluded from src/proxy.ts's matcher (which skips /api), so no locale or
// session refresh runs here — createClient() still works because Route
// Handlers read the request's cookies directly. Same shape as the employees
// and vacancies exports.
//
// Rows are re-fetched through the caller's own RLS-respecting client; nothing
// about WHICH units exist is accepted from the client. The screen's search
// text IS accepted and re-applied, so the file matches what the reader was
// looking at — and it can only narrow the result, never widen it.
//
// No extra permission gate: org_units_select is the boundary (a caller who
// can see nothing gets an empty sheet), exactly as on the screen itself.
/**
 * Export gate = the permission that shows /org-units on screen (no gate of its own: org_units_select's RLS (employeeData / vacancies / orgStructure view) decides).
 * See requireExportAccess for the product rule this encodes.
 */
const EXPORT_GATE: ExportGate = [];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const access = await requireExportAccess(supabase, EXPORT_GATE);
  if (!access.ok) return access.response;

  const { data } = await supabase
    .from("org_units")
    .select("id, name_ar, name_en, unit_code, kind_id, type_id, level_id, parent_id")
    .is("deleted_at", null)
    .order("name_ar");

  const units = (data ?? []) as Array<{
    id: string;
    name_ar: string;
    name_en: string | null;
    unit_code: string | null;
    kind_id: string;
    type_id: string | null;
    level_id: string | null;
    parent_id: string | null;
  }>;

  // The classifications are rows now (20260830000002), so their Arabic names
  // are read rather than looked up in a message catalogue that would go stale
  // the moment someone adds one from the screen.
  const [{ data: kindRows }, { data: typeRows }, { data: levelRows }] = await Promise.all([
    supabase.from("org_unit_kinds").select("id, name_ar").is("deleted_at", null),
    supabase.from("org_unit_types").select("id, name_ar").is("deleted_at", null),
    supabase.from("org_structure_levels").select("id, name_ar").is("deleted_at", null),
  ]);
  const kindName = new Map(((kindRows ?? []) as Array<{ id: string; name_ar: string }>).map((r) => [r.id, r.name_ar]));
  const typeName = new Map(((typeRows ?? []) as Array<{ id: string; name_ar: string }>).map((r) => [r.id, r.name_ar]));
  const levelName = new Map(((levelRows ?? []) as Array<{ id: string; name_ar: string }>).map((r) => [r.id, r.name_ar]));

  const byId = new Map(units.map((u) => [u.id, u]));
  const childCount = new Map<string, number>();
  for (const unit of units) {
    if (unit.parent_id) childCount.set(unit.parent_id, (childCount.get(unit.parent_id) ?? 0) + 1);
  }
  // Depth is what the tree on screen shows as indentation; the sheet has no
  // indentation, so it carries the number instead. Capped in case a corrupted
  // parent chain ever loops.
  const depthOf = (unit: (typeof units)[number]) => {
    let depth = 0;
    let cursor = unit.parent_id;
    while (cursor && depth < 100) {
      depth += 1;
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
    return depth;
  };

  const t = await getTranslations({ locale: "ar", namespace: "OrgUnitsPage" });
  const query = (request.nextUrl.searchParams.get("q") ?? "").trim();
  const visible = units.filter(
    (unit) =>
      query === "" ||
      unit.name_ar.includes(query) ||
      (unit.name_en ?? "").toLowerCase().includes(query.toLowerCase())
  );

  const columnLabels: Record<OrgUnitExportColumn, string> = {
    nameAr: t("fieldNameAr"),
    nameEn: t("fieldNameEn"),
    kind: t("fieldKind"),
    type: t("fieldType"),
    level: t("fieldLevel"),
    parent: t("fieldParent"),
    unitCode: t("fieldCode"),
    depth: t("exportColumnDepth"),
    childCount: t("exportColumnChildCount"),
  };

  const columns = selectColumns(ORG_UNIT_EXPORT_COLUMNS, request.nextUrl.searchParams.get("columns"));
  const cell = (unit: (typeof units)[number], column: OrgUnitExportColumn): string | number | null => {
    switch (column) {
      case "nameAr":
        return unit.name_ar;
      case "nameEn":
        return unit.name_en ?? "";
      case "kind":
        return kindName.get(unit.kind_id) ?? "";
      case "type":
        return unit.type_id ? typeName.get(unit.type_id) ?? "" : "";
      case "level":
        return unit.level_id ? levelName.get(unit.level_id) ?? "" : "";
      case "parent":
        return unit.parent_id ? (byId.get(unit.parent_id)?.name_ar ?? "") : "";
      case "unitCode":
        return unit.unit_code ?? "";
      case "depth":
        return depthOf(unit);
      case "childCount":
        return childCount.get(unit.id) ?? 0;
    }
  };

  return buildExportResponse({
    format: parseExportFormat(request.nextUrl.searchParams.get("format")),
    sheetName: "الوحدات التنظيمية",
    filenameBase: "org-units",
    headers: columns.map((c) => columnLabels[c]),
    rows: visible.map((unit) => columns.map((c) => cell(unit, c))),
    columnWidth: 22,
  });
}
