#!/usr/bin/env node
/**
 * One-off (2026-10-15): adds the "الرقم الوظيفي للرئيس المباشر" column to the
 * employees import template and one explanatory line to both instruction
 * sheets. Idempotent — re-running finds the header already there and exits.
 *
 *   node.exe scripts/onboarding/update-template.mjs
 */
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ExcelJS = require(path.join(process.cwd(), "node_modules/exceljs"));

const HEADER = "الرقم الوظيفي للرئيس المباشر";
const file = path.join(process.cwd(), "public/templates/sru-employees-import-template.xlsx");
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const data = wb.getWorksheet("Employees Data");
if (!data) throw new Error('sheet "Employees Data" not found');
const headers = [];
data.getRow(1).eachCell((c, i) => { headers[i] = String(c.value ?? "").trim(); });
if (headers.includes(HEADER)) { console.log("already present"); process.exit(0); }

const next = data.getRow(1).cellCount + 1;
const cell = data.getRow(1).getCell(next);
cell.value = HEADER;
cell.style = data.getRow(1).getCell(next - 1).style;
data.getColumn(next).width = 30;


const ar = wb.getWorksheet("تعليمات عربي");
if (ar) ar.addRow([`${HEADER}: اختياري. الرقم الوظيفي لرئيس الموظف المباشر كما في عمود EMPLOYEE NUMBER. الصف بلا رئيس، أو برئيس غير موجود، يُنشأ «بانتظار الاعتماد» ليُسند من شاشة الموظفين.`]);
const en = wb.getWorksheet("Instructions");
if (en) en.addRow([`${HEADER} (line manager employee number): optional. The manager's EMPLOYEE NUMBER. A row without a manager, or whose manager is unknown, is created as pending so it can be placed from the Employees screen.`]);
await wb.xlsx.writeFile(file);
console.log("template updated:", next, "columns");
