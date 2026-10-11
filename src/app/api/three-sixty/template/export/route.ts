import ExcelJS from "exceljs";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildExportResponse, parseExportFormat } from "@/lib/exportResponse";
import { threeSixtyTemplateColumnLabels, THREE_SIXTY_TEMPLATE_SHEETS } from "@/lib/threeSixtyTemplateExcel";
import { requireExportAccess, type ExportGate } from "@/lib/exportAuth";

// Excluded from src/proxy.ts's matcher, so no locale/session-refresh happens
// here — createClient() still works because Route Handlers read the
// request's cookies directly, same as Server Components (see
// src/app/api/employees/export/route.ts, the precedent this follows).
//
// No extra permission gate beyond being signed in: `three_sixty_rater_
// groups`/`rating_scale_options`/`competencies`/`items` are all read-open to
// any authenticated user (20260902000002's own RLS design), so this route
// re-runs exactly that same boundary rather than inventing a stricter one.
// Every row comes from the caller's own RLS-respecting client, never
// accepted from the request.
/**
 * Export gate = the permission that shows /three-sixty/template on screen (the page itself shows errorForbidden below prepare).
 * See requireExportAccess for the product rule this encodes.
 */
const EXPORT_GATE: ExportGate = [{ area: "threeSixty", minLevel: "prepare" }];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const access = await requireExportAccess(supabase, EXPORT_GATE);
  if (!access.ok) return access.response;

  const [{ data: raterGroups }, { data: scaleOptions }, { data: competencies }, { data: items }] = await Promise.all([
    supabase
      .from("three_sixty_rater_groups")
      .select("relationship_code, name_ar, group_weight_pct, min_raters_in_group, max_raters_in_group, shown_separately, employee_may_nominate")
      .is("deleted_at", null)
      .order("relationship_code"),
    supabase
      .from("three_sixty_rating_scale_options")
      .select("scale_code, option_code, label_ar, numeric_value, counted_in_score")
      .is("deleted_at", null)
      .order("scale_code")
      .order("numeric_value"),
    supabase
      .from("three_sixty_competencies")
      .select("competency_code, name_ar, definition_ar, weight_pct, applies_to")
      .is("deleted_at", null)
      .order("competency_code"),
    supabase
      .from("three_sixty_items")
      .select(
        "item_code, competency_id, item_type, text_ar, rater_groups, required, reverse_scored, scale_code, display_order, behavioral_level, three_sixty_competencies(competency_code)"
      )
      .is("deleted_at", null)
      .order("display_order"),
  ]);

  const format = parseExportFormat(request.nextUrl.searchParams.get("format"));
  const requestedSheets = request.nextUrl.searchParams.get("sheets");
  const wantedSheets = requestedSheets
    ? new Set(requestedSheets.split(",").map((v) => v.trim()).filter(Boolean))
    : null;

  const workbook = new ExcelJS.Workbook();
  const collected: Array<{ key: string; name: string; headers: string[]; rows: Array<Array<string | number | null>> }> = [];

  function addSheet(key: keyof typeof THREE_SIXTY_TEMPLATE_SHEETS, rows: Array<Array<string | number | null>>) {
    const name = THREE_SIXTY_TEMPLATE_SHEETS[key];
    const headers = Object.values(threeSixtyTemplateColumnLabels(key));
    if (wantedSheets && !wantedSheets.has(key)) return;
    collected.push({ key, name, headers, rows });
    if (format === "csv") return;
    const sheet = workbook.addWorksheet(name, { views: [{ rightToLeft: true }] });
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) sheet.addRow(row);
    sheet.columns.forEach((col) => {
      col.width = 22;
    });
  }

  addSheet(
    "ratingScale",
    (scaleOptions ?? []).map((o) => [o.scale_code, o.option_code, o.label_ar, o.numeric_value, o.counted_in_score ? "TRUE" : "FALSE"])
  );
  addSheet(
    "raterGroup",
    (raterGroups ?? []).map((g) => [
      g.relationship_code,
      g.name_ar,
      g.group_weight_pct,
      g.min_raters_in_group,
      g.max_raters_in_group,
      g.shown_separately ? "TRUE" : "FALSE",
      g.employee_may_nominate ? "TRUE" : "FALSE",
    ])
  );
  addSheet(
    "competency",
    (competencies ?? []).map((c) => [c.competency_code, c.name_ar, c.definition_ar, c.weight_pct, c.applies_to])
  );
  addSheet(
    "item",
    ((items ?? []) as unknown as Array<{
      item_code: string;
      item_type: string;
      text_ar: string;
      rater_groups: string[];
      required: boolean;
      reverse_scored: boolean;
      scale_code: string | null;
      display_order: number;
      behavioral_level: string | null;
      three_sixty_competencies: { competency_code: string } | null;
    }>).map((i) => [
      i.item_code,
      i.three_sixty_competencies?.competency_code ?? "",
      i.item_type,
      i.text_ar,
      i.rater_groups.join(","),
      i.required ? "TRUE" : "FALSE",
      i.reverse_scored ? "TRUE" : "FALSE",
      i.scale_code,
      i.display_order,
      i.behavioral_level,
    ])
  );

  if (format === "csv") {
    const sheet = collected[0];
    if (!sheet) {
      return NextResponse.json({ error: "no_sheet_selected" }, { status: 400 });
    }
    return buildExportResponse({
      format: "csv",
      sheetName: sheet.name,
      filenameBase: `three-sixty-template-${sheet.key}`,
      headers: sheet.headers,
      rows: sheet.rows,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="three-sixty-template.xlsx"`,
    },
  });
}
