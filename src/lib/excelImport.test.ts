import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { cellNumber, cellText, headerMap, loadImportWorkbook, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from "./excelImport";

async function workbookFile(rows: Array<Array<string | number>>, name = "test.xlsx"): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("ورقة");
  for (const row of rows) sheet.addRow(row);
  const buffer = await wb.xlsx.writeBuffer();
  return new File([buffer as ArrayBuffer], name);
}

describe("cellText", () => {
  it("returns null for an empty cell", () => {
    expect(cellText(null)).toBeNull();
    expect(cellText(undefined)).toBeNull();
    expect(cellText("   ")).toBeNull();
  });

  it("trims plain values and stringifies numbers", () => {
    expect(cellText("  مدير  ")).toBe("مدير");
    expect(cellText(12)).toBe("12");
  });

  it("reads rich-text and hyperlink cells through their text", () => {
    expect(cellText({ richText: [{ text: "أ" }, { text: "ب" }], text: " أب " } as unknown as ExcelJS.CellValue)).toBe("أب");
  });
});

describe("cellNumber", () => {
  it("parses Arabic-Indic digits and thousands separators", () => {
    expect(cellNumber("١٢٬٥٠٠")).toBe(12500);
    expect(cellNumber("4,802")).toBe(4802);
  });

  it("returns null for blanks and non-numeric text", () => {
    expect(cellNumber(null)).toBeNull();
    expect(cellNumber("غير محدد")).toBeNull();
  });
});

describe("headerMap", () => {
  it("maps trimmed header text to its 1-based column and skips blank headers", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("s");
    sheet.addRow([" الاسم ", "", "الدرجة"]);
    const map = headerMap(sheet);
    expect(map.get("الاسم")).toBe(1);
    expect(map.get("الدرجة")).toBe(3);
    expect(map.size).toBe(2);
  });
});

describe("loadImportWorkbook", () => {
  it("rejects anything that is not a non-empty File", async () => {
    expect(await loadImportWorkbook(null)).toEqual({ ok: false, reason: "invalid_input" });
    expect(await loadImportWorkbook("file.xlsx")).toEqual({ ok: false, reason: "invalid_input" });
    expect(await loadImportWorkbook(new File([], "empty.xlsx"))).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("rejects a file over the byte limit before trying to parse it", async () => {
    const big = new File([new Uint8Array(IMPORT_MAX_BYTES + 1)], "big.xlsx");
    expect(await loadImportWorkbook(big)).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects a workbook whose sheet has more data rows than the limit", async () => {
    const rows: Array<Array<string>> = [["h"]];
    for (let i = 0; i < IMPORT_MAX_ROWS + 1; i++) rows.push([`r${i}`]);
    expect(await loadImportWorkbook(await workbookFile(rows))).toEqual({ ok: false, reason: "too_many_rows" });
  });

  it("rejects bytes that are not a workbook", async () => {
    expect(await loadImportWorkbook(new File(["not an xlsx"], "x.xlsx"))).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("loads a valid workbook", async () => {
    const result = await loadImportWorkbook(await workbookFile([["h"], ["v"]]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workbook.worksheets[0].rowCount).toBe(2);
  });
});
