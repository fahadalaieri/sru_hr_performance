import ExcelJS from "exceljs";

/**
 * Shared Excel-import plumbing (2026-10-07).
 *
 * Nine import Server Actions each carried their own copy of `cellText`,
 * most their own `headerMap`, two their own `cellNumber`, and all nine loaded
 * the uploaded file with no size or row limit — only the preview action
 * (`inspect-excel.ts`) enforced the limits the dialog promises. A limit
 * checked in the preview but not in the import itself is no limit: the
 * import action is a public Server Action a client can call directly with
 * any file. These helpers are the one copy, and `loadImportWorkbook` is the
 * one place the limits live, so every importer enforces them by construction.
 */

/** Same figures the import dialog shows the user; enforced, not decorative. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 2000;

/**
 * A cell's text, or null when it is blank. Handles ExcelJS's rich-text
 * (`{richText:[...]}`), formula (`{result}`) and hyperlink (`{text}`) shapes
 * — a plain `String()` on those yields "[object Object]" and would be
 * imported as a real value.
 */
export function cellText(value: ExcelJS.CellValue | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "object") {
    const rich = (value as { richText?: Array<{ text?: string }> }).richText;
    if (Array.isArray(rich)) return nonEmpty(rich.map((part) => part.text ?? "").join(""));
    const result = (value as { result?: unknown }).result;
    if (result != null) return cellText(result as ExcelJS.CellValue);
    const text = (value as { text?: unknown }).text;
    if (text != null) return cellText(text as ExcelJS.CellValue);
    if (value instanceof Date) return value.toISOString();
    return null;
  }
  return nonEmpty(String(value));
}

function nonEmpty(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/** A numeric cell, accepting Arabic-Indic digits and thousands separators (both "," and "٬"). */
export function cellNumber(value: ExcelJS.CellValue | undefined): number | null {
  const text = cellText(value);
  if (text == null) return null;
  const normalized = text
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[,٬]/g, "")
    .replace(/٫/g, ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Header text → 1-based column number, from row 1; blank headers are skipped. */
export function headerMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const text = cellText(cell.value);
    if (text) map.set(text, colNumber);
  });
  return map;
}

export type LoadImportWorkbookResult =
  | { ok: true; workbook: ExcelJS.Workbook }
  | { ok: false; reason: "invalid_input" | "too_large" | "too_many_rows" };

/**
 * Validates and parses an uploaded workbook. Order matters: the byte limit
 * is checked BEFORE parsing, so an oversized upload never reaches ExcelJS;
 * the row limit is checked after parsing on the DATA rows summed across all
 * sheets (row 1 of each sheet is its header) — the same figure the preview
 * action reports to the dialog, so both agree on what "too many" means.
 */
export async function loadImportWorkbook(file: unknown): Promise<LoadImportWorkbookResult> {
  if (!(file instanceof File) || file.size === 0) return { ok: false, reason: "invalid_input" };
  if (file.size > IMPORT_MAX_BYTES) return { ok: false, reason: "too_large" };
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch {
    return { ok: false, reason: "invalid_input" };
  }
  const dataRows = workbook.worksheets.reduce((sum, sheet) => sum + Math.max(0, sheet.rowCount - 1), 0);
  if (dataRows > IMPORT_MAX_ROWS) return { ok: false, reason: "too_many_rows" };
  return { ok: true, workbook };
}
