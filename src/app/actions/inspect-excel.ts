"use server";

import { createClient } from "@/lib/supabase/server";
import { cellText, loadImportWorkbook } from "@/lib/excelImport";

export type InspectExcelResult =
  | {
      status: "success";
      sheets: Array<{ name: string; headers: string[]; rowCount: number }>;
    }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "empty" | "too_large" | "too_many_rows" };

/**
 * Reads an uploaded workbook's sheet names, header row and row count so the
 * import dialog can ask the caller to map columns BEFORE anything is written.
 *
 * Deliberately writes nothing and touches no table: it parses the file the
 * caller just picked and hands back its own headers. The only gate is being
 * signed in — there is no data here to authorise access to, and the real
 * import that follows is where each table's own RLS applies as it always has.
 *
 * Parsing server-side rather than in the browser keeps `exceljs` out of the
 * client bundle; it is already a server dependency of every importer.
 */
export async function inspectExcelFile(_prev: InspectExcelResult | null, formData: FormData): Promise<InspectExcelResult> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "invalid_input" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "unauthenticated" };

  // Same limits, same helper, as every import action (src/lib/excelImport.ts).
  const loaded = await loadImportWorkbook(file);
  if (!loaded.ok) return { status: "error", message: loaded.reason };
  const workbook = loaded.workbook;

  const sheets: Array<{ name: string; headers: string[]; rowCount: number }> = [];
  workbook.eachSheet((sheet) => {
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell) => {
      const text = cellText(cell.value);
      // A blank header cannot be mapped to anything and would render as an
      // unnamed row in the dialog.
      if (text) headers.push(text);
    });
    // Row 1 is the header, so the data rows are what is left.
    sheets.push({ name: sheet.name, headers, rowCount: Math.max(0, sheet.rowCount - 1) });
  });

  if (sheets.every((s) => s.headers.length === 0)) {
    return { status: "error", message: "empty" };
  }

  return { status: "success", sheets };
}
