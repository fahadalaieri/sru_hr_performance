// Pure helpers for the staff bulk onboarding merge
// (docs/superpowers/specs/2026-10-15-staff-bulk-onboarding-design.md §4-أ).
// No database, no file system: the CLI (merge-staff.mjs) feeds text in and
// writes the workbook out; lib.test.ts covers the rules.

/** The "Employees Data" header the platform's import already understands, plus the supervisor column (importColumns.ts). */
export const OUTPUT_HEADERS = ["EMPLOYEE NUMBER", "اسم الموظف", "EMAIL ID", "Employee Name", "الادارة", "اسم الوظيفة", "Category", "الرقم الوظيفي للرئيس المباشر"];

/** RFC 4180 CSV → rows; strips a BOM; drops fully blank lines. */
export function parseCsv(text) {
  let raw = text;
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const rows = [];
  let cur = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cur.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      cur.push(field); rows.push(cur); cur = []; field = "";
    } else field += ch;
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * Reads sheet1 of a workbook whose XML uses the `x:` namespace prefix (the HR
 * line-manager export; ExcelJS fails on it with "Cannot read properties of
 * undefined (reading 'sheets')", confirmed 2026-10-15). `readPart(name)`
 * returns one zip entry as text. Returns the header row and the data rows
 * below it, each aligned to the header's columns.
 */
export function parseOoxmlSheet(readPart, { headerRow = 1 } = {}) {
  const sst = [...readPart("xl/sharedStrings.xml").matchAll(/<x:si>(.*?)<\/x:si>/gs)].map((m) =>
    unesc([...m[1].matchAll(/<x:t[^>]*>(.*?)<\/x:t>/gs)].map((t) => t[1]).join(""))
  );
  const cells = new Map(); // row number → { column letters → text }
  for (const m of readPart("xl/worksheets/sheet1.xml").matchAll(/<x:c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>(.*?)<\/x:c>)/gs)) {
    const [, col, rn, attrs, inner] = m;
    if (!inner) continue;
    const v = (inner.match(/<x:v>(.*?)<\/x:v>/s) || [])[1];
    const is = (inner.match(/<x:is>.*?<x:t[^>]*>(.*?)<\/x:t>/s) || [])[1];
    let val = "";
    if (/t="s"/.test(attrs) && v != null) val = sst[Number(v)] ?? "";
    else if (is != null) val = unesc(is);
    else if (v != null) val = unesc(v);
    const r = cells.get(Number(rn)) || {};
    r[col] = val.trim();
    cells.set(Number(rn), r);
  }
  const colIndex = (c) => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const toArray = (r) => { const arr = []; for (const [c, v] of Object.entries(r)) arr[colIndex(c)] = v; return arr; };
  const header = toArray(cells.get(headerRow) || {}).map((h) => (h ?? "").trim());
  const rows = [...cells.entries()]
    .filter(([n]) => n > headerRow)
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => { const arr = toArray(r); return header.map((_, i) => arr[i] ?? ""); })
    .filter((r) => r.some(Boolean));
  return { header, rows };
}

const col = (header, name) => header.findIndex((h) => h.trim() === name);
const clean = (v) => { const t = (v ?? "").trim(); return t === "" ? null : t; };

/**
 * Joins the directory export and the HR line-manager sheet by employee number.
 * Precedence per field (spec §4-أ): name / email / department / category from
 * the directory, else HR; English name, official title and supervisor from HR.
 * Rows without an employee number in either file (shared mailboxes, externals)
 * are excluded. Sub-departments are dropped (decision 3). `aliases` rewrites a
 * department name exactly (decision 6).
 */
export function mergeStaff({ directoryRows, hrRows, aliases = {} }) {
  const dh = directoryRows[0];
  const d = { no: col(dh, "الرقم الوظيفي"), name: col(dh, "الاسم"), email: col(dh, "البريد"), dept: col(dh, "الإدارة"), pos: col(dh, "المسمّى"), cat: col(dh, "الفئة") };
  const hh = hrRows.header;
  const h = { no: col(hh, "UNIQUE EMPLOYEE NUMBER"), cat: col(hh, "Worker Category"), nameEn: col(hh, "Full Name"), nameAr: col(hh, "الأسم بالعربي"), title: col(hh, "اسم الوظيفة"), dept: col(hh, "إسم القسم"), lm: col(hh, "line manager UNIQUE EMPLOYEE NUMBER") };
  for (const [k, i] of Object.entries(d)) if (i < 0) throw new Error(`directory CSV: missing column ${k}`);
  for (const [k, i] of Object.entries(h)) if (i < 0) throw new Error(`HR sheet: missing column ${k}`);

  const byNo = new Map();
  let excludedNoNumber = 0;
  for (const r of directoryRows.slice(1)) {
    const no = clean(r[d.no]);
    if (!no) { excludedNoNumber++; continue; }
    byNo.set(no, { dir: r });
  }
  for (const r of hrRows.rows) {
    const no = clean(r[h.no]);
    if (!no) { excludedNoNumber++; continue; }
    byNo.set(no, { ...(byNo.get(no) || {}), hr: r });
  }

  const rows = [];
  const nameConflicts = [];
  let withoutEmail = 0, withoutSupervisor = 0, onlyInHr = 0, onlyInDirectory = 0;
  const ordered = [...byNo.entries()].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }));
  for (const [no, { dir, hr }] of ordered) {
    if (!dir) onlyInHr++;
    if (!hr) onlyInDirectory++;
    const dirName = dir ? clean(dir[d.name]) : null;
    const hrName = hr ? clean(hr[h.nameAr]) : null;
    if (dirName && hrName && dirName !== hrName) nameConflicts.push(`${no}: الدليل «${dirName}» / الموارد البشرية «${hrName}»`);
    const rawDept = (dir ? clean(dir[d.dept]) : null) ?? (hr ? clean(hr[h.dept]) : null);
    const email = (dir ? clean(dir[d.email]) : null)?.toLowerCase() ?? null;
    const supervisorNumber = hr ? clean(hr[h.lm]) : null;
    if (!email) withoutEmail++;
    if (!supervisorNumber) withoutSupervisor++;
    rows.push({
      employeeNumber: no,
      fullNameAr: dirName ?? hrName ?? no,
      fullNameEn: hr ? clean(hr[h.nameEn]) : null,
      email,
      department: rawDept ? (aliases[rawDept] ?? rawDept) : null,
      positionAr: (hr ? clean(hr[h.title]) : null) ?? (dir ? clean(dir[d.pos]) : null),
      category: (dir ? clean(dir[d.cat]) : null) ?? (hr ? clean(hr[h.cat]) : null),
      supervisorNumber,
    });
  }

  const next = new Map(rows.map((r) => [r.employeeNumber, r.supervisorNumber === r.employeeNumber ? null : r.supervisorNumber]));
  const cycles = new Set();
  for (const r of rows) {
    const seen = new Set();
    const path = [];
    let cur = r.employeeNumber;
    while (cur && next.has(cur) && !seen.has(cur)) { seen.add(cur); path.push(cur); cur = next.get(cur); }
    if (cur && seen.has(cur)) for (const n of path.slice(path.indexOf(cur))) cycles.add(n);
  }
  return { rows, report: { total: rows.length, excludedNoNumber, withoutEmail, withoutSupervisor, onlyInHr, onlyInDirectory, nameConflicts, cycles: [...cycles] } };
}
