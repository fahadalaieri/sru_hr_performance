#!/usr/bin/env node
/**
 * Merges the two HR source files into ONE "Employees Data" sheet the platform's
 * existing Excel import understands (plus the supervisor column), and prints
 * a merge report. See README.md in this folder.
 *
 *   node.exe scripts/onboarding/merge-staff.mjs <directory.csv> <line-manager.xlsx> <out.xlsx>
 *            [--aliases scripts/onboarding/unit-aliases.json] [--units units.txt]
 *
 * --units: a text file with one org unit name per line (the platform's
 *          org_units.name_ar); departments not in it are listed in the report
 *          so they can be fixed BEFORE upload. Optional.
 * Exit code 1 when the HR file contains a supervisor cycle (fix the file first).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mergeStaff, parseCsv, parseOoxmlSheet, OUTPUT_HEADERS } from "./lib.mjs";

const require = createRequire(import.meta.url);
const ExcelJS = require(path.join(process.cwd(), "node_modules/exceljs"));

const [csvPath, xlsxPath, outPath, ...flags] = process.argv.slice(2);
if (!csvPath || !xlsxPath || !outPath) {
  console.error("usage: merge-staff.mjs <directory.csv> <line-manager.xlsx> <out.xlsx> [--aliases f.json] [--units f.txt]");
  process.exit(2);
}
const flag = (n) => { const i = flags.indexOf(n); return i >= 0 ? flags[i + 1] : null; };
const aliases = flag("--aliases") ? JSON.parse(fs.readFileSync(flag("--aliases"), "utf8")) : {};
const unitNames = flag("--units")
  ? new Set(fs.readFileSync(flag("--units"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  : null;

// The HR workbook uses the `x:` XML prefix that ExcelJS rejects; read its parts straight out of the zip.
const readPart = (name) => execFileSync("unzip", ["-p", xlsxPath, name], { maxBuffer: 1 << 26 }).toString("utf8");

const { rows, report } = mergeStaff({
  directoryRows: parseCsv(fs.readFileSync(csvPath, "utf8")),
  hrRows: parseOoxmlSheet(readPart, { headerRow: 2 }),
  aliases,
});

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Employees Data");
ws.addRow(OUTPUT_HEADERS);
for (const r of rows) {
  ws.addRow([r.employeeNumber, r.fullNameAr, r.email ?? "", r.fullNameEn ?? "", r.department ?? "", r.positionAr ?? "", r.category ?? "", r.supervisorNumber ?? ""]);
}
await wb.xlsx.writeFile(outPath);

const unknownUnits = unitNames ? [...new Set(rows.map((r) => r.department).filter((u) => u && !unitNames.has(u)))] : null;
console.log(JSON.stringify({ ...report, unknownUnits, output: outPath }, null, 2));
if (report.cycles.length) {
  console.error("supervisor cycles found — fix the HR file before importing");
  process.exit(1);
}
