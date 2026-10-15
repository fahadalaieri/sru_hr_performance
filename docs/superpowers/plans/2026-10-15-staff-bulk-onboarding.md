# Staff Bulk Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load all ~300 university staff into the platform once, each placed (org unit, supervisor, title hint) with derived roles, so a first SSO login lands the employee in place and the platform admin only confirms what the files could not resolve.

**Architecture:** A pure merge script joins the directory CSV and the HR line-manager workbook into one sheet of the existing employees import template plus a supervisor column. The employee half of the existing Excel import is extracted into a library function (`src/lib/staffImport.ts`) that gains a supervisor pass, explicit approval status, a job-title hint, derived roles and a dry run; the Server Action stays a thin wrapper. The approval queue learns to place a pending employee in the same step.

**Tech Stack:** Next.js 16 Server Actions, Supabase (PostgREST through the caller's RLS client), ExcelJS (writing + reading standard workbooks), Zod 4, Vitest 4 (unit colocated; integration under `tests/integration` against the dev DB), node 24 `.mjs` scripts.

**Spec:** `docs/superpowers/specs/2026-10-15-staff-bulk-onboarding-design.md`

## Global Constraints

- Every write goes through the caller's RLS client; the admin (service-role) client is used only for `audit_log` (existing rule in `import-actions.ts`).
- Soft delete only; nothing in this plan deletes profiles or roles.
- Zod on every new Server Action input; `check_vpra` re-checked server-side for the approval placement.
- Org-unit matching is exact on trimmed `org_units.name_ar` (no fuzzy matching) — existing owner rule.
- No new job titles are created from free text (spec decision 5). The import's existing title creation only fires when a `GRADE CODE` is present; the merged file carries none.
- Nothing from the directory beyond name, email, org unit, category is stored (spec §2). The extension (`التحويلة`) and confirmation state are dropped by the merge script.
- Arabic UI strings live in `messages/ar.json` + `messages/en.json` (both files, same keys).
- CRLF: repo files are CRLF; scripts that patch files must preserve line endings (use the Edit tool).
- Dev database only until the owner says otherwise (`mrunvowuhiwwwajzdiwl`); never the production ref `rrzrrytrdhgmypxjfbmw`.

## Review Focus

1. A row whose email already belongs to a profile with a different employee number: PostgREST rejects the whole batch of 50 with 23505. Expected: that one row is reported and skipped, the other 49 land. (Task 4 test "email collision is isolated".)
2. A supervisor number that refers to a row the same import skipped (e.g. because of 1): expected the subordinate is created pending with "unknown supervisor" in the report, never a crash. (Task 4 test "unresolved supervisor → pending".)
3. Re-running the file in "add new only" mode: existing rows must keep their approval status, supervisor and manually chosen title; only new rows are written and linked. (Task 4 test "insert_only re-run leaves existing rows alone".)
4. A supervisor number equal to the employee's own number (HR typo): the CHECK `profiles_supervisor_not_self` would fail the update. Expected: skipped with a report line. (Task 2 unit test "self-supervision is reported", Task 4 wiring.)
5. The president (no supervisor, supervises others): must be created approved with `manager` on their unit, not pending. (Task 2 unit test "root with reports is a head", Task 4 test "root is approved".)

---

### Task 1: Migration — `profiles.job_title_hint`

**Files:**
- Create: `supabase/migrations/20261015000001_profiles_job_title_hint.sql`
- Test: `tests/integration/migrations-ledger.integration.test.ts` (existing; rejects duplicate version numbers — nothing to add)

**Interfaces:**
- Produces: column `profiles.job_title_hint text NULL` read by Task 4 (write) and Task 5 (display).

- [ ] **Step 1: Write the migration**

```sql
-- 2026-10-15 — staff bulk onboarding (docs/superpowers/specs/2026-10-15-staff-bulk-onboarding-design.md §4-ب item 4).
-- The HR file carries free-text job titles (189 distinct) that do not match the
-- platform's 280 official titles. They are kept as a HINT for the platform admin
-- to confirm against the official list, never turned into new job_titles rows.
BEGIN;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS job_title_hint text;
COMMENT ON COLUMN profiles.job_title_hint IS 'Free-text title from the HR import (or SSO directory); shown next to the official title picker until a job_title_id is chosen. Never a source of truth.';

SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'job_title_hint';

COMMIT;
```

- [ ] **Step 2: Apply to the dev database and verify**

Run (from repo root, Git Bash):
```bash
PROJECT_DIR="$PWD" node.exe scripts/dev-seed/migrate.mjs --only 20261015000001
```
If `migrate.mjs` has no `--only` flag, apply with the Supabase MCP `apply_migration` on project `mrunvowuhiwwwajzdiwl` (name `profiles_job_title_hint`). Then verify:
```bash
PROJECT_DIR="$PWD" node.exe -e "..."  # or: select column_name from information_schema.columns where table_name='profiles' and column_name='job_title_hint'
```
Expected: one row `job_title_hint`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20261015000001_profiles_job_title_hint.sql
git commit -m "هجرة: عمود job_title_hint في profiles لتلميح المسمّى من ملف الموارد البشرية"
```

---

### Task 2: Pure placement rules — `src/lib/staffPlacement.ts`

**Files:**
- Create: `src/lib/staffPlacement.ts`
- Test: `src/lib/staffPlacement.test.ts`

**Interfaces:**
- Produces:
```ts
export interface PlacementRow { employeeNumber: string; orgUnitId: string | null; supervisorNumber: string | null }
export interface PlacementVerdict {
  approved: boolean;                 // org unit resolved AND (supervisor resolved OR this row is a root that supervises someone)
  isSupervisor: boolean;             // someone in the set names this number as supervisor
  headOfOrgUnitId: string | null;    // own org unit id when this row heads it (supervises someone in its unit and its own supervisor is absent or in another unit)
  supervisorResolved: boolean;       // supervisorNumber is non-null and resolves inside `known`
  selfSupervision: boolean;          // supervisorNumber === employeeNumber (reported, never written)
}
export function placeRows(rows: PlacementRow[], known: ReadonlyMap<string, { orgUnitId: string | null }>): Map<string, PlacementVerdict>
export function findSupervisorCycles(rows: PlacementRow[]): string[]   // employee numbers that sit on a cycle
```
`known` = every employee number the import can link to: the rows of this file plus profiles already in the database (number → org unit). Task 4 builds it.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { findSupervisorCycles, placeRows, type PlacementRow } from "./staffPlacement";

const U1 = "unit-1", U2 = "unit-2";
const rows: PlacementRow[] = [
  { employeeNumber: "100", orgUnitId: U1, supervisorNumber: null },   // president: root, supervises 200
  { employeeNumber: "200", orgUnitId: U2, supervisorNumber: "100" },  // dean of U2: supervisor in another unit, supervises 300
  { employeeNumber: "300", orgUnitId: U2, supervisorNumber: "200" },  // plain employee
  { employeeNumber: "400", orgUnitId: null, supervisorNumber: "200" },// unmatched unit → pending
  { employeeNumber: "500", orgUnitId: U2, supervisorNumber: "999" },  // unknown supervisor → pending
  { employeeNumber: "600", orgUnitId: U1, supervisorNumber: "600" },  // self-supervision
  { employeeNumber: "700", orgUnitId: U1, supervisorNumber: null },   // no supervisor, supervises nobody → pending
];
const known = new Map(rows.map((r) => [r.employeeNumber, { orgUnitId: r.orgUnitId }]));

describe("placeRows", () => {
  const v = placeRows(rows, known);
  it("root with reports is a head and approved", () => {
    expect(v.get("100")).toMatchObject({ approved: true, isSupervisor: true, headOfOrgUnitId: U1, supervisorResolved: false });
  });
  it("supervisor whose own supervisor sits in another unit heads their unit", () => {
    expect(v.get("200")).toMatchObject({ approved: true, isSupervisor: true, headOfOrgUnitId: U2, supervisorResolved: true });
  });
  it("plain employee is approved and heads nothing", () => {
    expect(v.get("300")).toMatchObject({ approved: true, isSupervisor: false, headOfOrgUnitId: null });
  });
  it("unmatched org unit → pending even with a resolved supervisor", () => {
    expect(v.get("400")!.approved).toBe(false);
    expect(v.get("400")!.supervisorResolved).toBe(true);
  });
  it("unresolved supervisor → pending", () => {
    expect(v.get("500")).toMatchObject({ approved: false, supervisorResolved: false });
  });
  it("self-supervision is reported and not treated as resolved", () => {
    expect(v.get("600")).toMatchObject({ selfSupervision: true, supervisorResolved: false, approved: false });
  });
  it("a leaf without supervisor is pending, not a head", () => {
    expect(v.get("700")).toMatchObject({ approved: false, headOfOrgUnitId: null, isSupervisor: false });
  });
  it("a supervisor known only from the database (not in the file) still resolves", () => {
    const k = new Map(known); k.set("999", { orgUnitId: U1 });
    expect(placeRows(rows, k).get("500")!.supervisorResolved).toBe(true);
  });
});

describe("findSupervisorCycles", () => {
  it("returns the numbers on a cycle and nothing else", () => {
    const cyc: PlacementRow[] = [
      { employeeNumber: "1", orgUnitId: null, supervisorNumber: "2" },
      { employeeNumber: "2", orgUnitId: null, supervisorNumber: "1" },
      { employeeNumber: "3", orgUnitId: null, supervisorNumber: "1" },
    ];
    expect(findSupervisorCycles(cyc).sort()).toEqual(["1", "2"]);
    expect(findSupervisorCycles(rows)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/staffPlacement.test.ts`
Expected: FAIL — cannot resolve `./staffPlacement`.

- [ ] **Step 3: Implement**

```ts
/**
 * Placement rules for the staff bulk import (spec §4-ب items 2 and 5).
 * Pure: no database, no Excel. The import feeds it the file's rows plus the
 * numbers it already knows from `profiles`, and reads back per-row verdicts.
 */
export interface PlacementRow { employeeNumber: string; orgUnitId: string | null; supervisorNumber: string | null }
export interface PlacementVerdict {
  approved: boolean;
  isSupervisor: boolean;
  headOfOrgUnitId: string | null;
  supervisorResolved: boolean;
  selfSupervision: boolean;
}

export function placeRows(rows: PlacementRow[], known: ReadonlyMap<string, { orgUnitId: string | null }>): Map<string, PlacementVerdict> {
  const byNumber = new Map(rows.map((r) => [r.employeeNumber, r]));
  // Who supervises whom, from this file only (the database's existing links are not re-derived here).
  const reports = new Map<string, PlacementRow[]>();
  for (const r of rows) {
    if (!r.supervisorNumber || r.supervisorNumber === r.employeeNumber) continue;
    const list = reports.get(r.supervisorNumber) ?? [];
    list.push(r);
    reports.set(r.supervisorNumber, list);
  }
  const out = new Map<string, PlacementVerdict>();
  for (const r of rows) {
    const selfSupervision = r.supervisorNumber != null && r.supervisorNumber === r.employeeNumber;
    const supervisorResolved = !selfSupervision && r.supervisorNumber != null && known.has(r.supervisorNumber);
    const myReports = reports.get(r.employeeNumber) ?? [];
    const isSupervisor = myReports.length > 0;
    const supervisorUnit = supervisorResolved ? (byNumber.get(r.supervisorNumber!)?.orgUnitId ?? known.get(r.supervisorNumber!)?.orgUnitId ?? null) : null;
    const supervisesOwnUnit = r.orgUnitId != null && myReports.some((x) => x.orgUnitId === r.orgUnitId);
    const headOfOrgUnitId = supervisesOwnUnit && (!supervisorResolved || supervisorUnit !== r.orgUnitId) ? r.orgUnitId : null;
    const approved = r.orgUnitId != null && (supervisorResolved || (r.supervisorNumber == null && isSupervisor));
    out.set(r.employeeNumber, { approved, isSupervisor, headOfOrgUnitId, supervisorResolved, selfSupervision });
  }
  return out;
}

export function findSupervisorCycles(rows: PlacementRow[]): string[] {
  const next = new Map(rows.map((r) => [r.employeeNumber, r.supervisorNumber]));
  const onCycle = new Set<string>();
  for (const r of rows) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | null | undefined = r.employeeNumber;
    while (cur && next.has(cur) && !seen.has(cur)) { seen.add(cur); path.push(cur); cur = next.get(cur); }
    if (cur && seen.has(cur)) for (const n of path.slice(path.indexOf(cur))) onCycle.add(n);
  }
  return [...onCycle];
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/staffPlacement.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/staffPlacement.ts src/lib/staffPlacement.test.ts
git commit -m "قواعد الإسناد النقية للتحميل الجماعي: الاعتماد، الرئيس المباشر، رئيس الوحدة، الحلقات"
```

---

### Task 3: Merge script — `scripts/onboarding/`

**Files:**
- Create: `scripts/onboarding/lib.mjs` (pure: parse CSV text, parse the `x:`-prefixed OOXML sheet, merge, report)
- Create: `scripts/onboarding/merge-staff.mjs` (CLI: reads the two files, writes `Employees Data` workbook + report)
- Create: `scripts/onboarding/unit-aliases.json`
- Create: `scripts/onboarding/README.md`
- Test: `scripts/onboarding/lib.test.ts` (Vitest picks up `**/*.test.ts` outside `tests/`; `node_modules`/`.next` are excluded)

**Interfaces:**
- Produces (lib.mjs):
```js
export function parseCsv(text)            // → string[][] (RFC 4180, BOM stripped)
export function parseOoxmlSheet(zipPartReader, { headerRow })   // zipPartReader(name) → string; returns { header: string[], rows: string[][] }
export function mergeStaff({ directoryRows, hrRows, aliases }) // → { rows: MergedRow[], report: MergeReport }
// MergedRow: { employeeNumber, fullNameAr, fullNameEn, email, department, positionAr, category, supervisorNumber }
// MergeReport: { total, excludedNoNumber, withoutEmail, withoutSupervisor, onlyInHr, onlyInDirectory, nameConflicts: string[], cycles: string[] }
export const OUTPUT_HEADERS = ["EMPLOYEE NUMBER","اسم الموظف","EMAIL ID","Employee Name","الادارة","اسم الوظيفة","Category","الرقم الوظيفي للرئيس المباشر"]
```
- Directory CSV headers (exact): `الاسم, البريد, الإدارة, المسمّى, التحويلة, الفئة, الرقم الوظيفي, الحالة`.
- HR workbook: header row **2**, table `A2:L299`, columns in order: `UNIQUE EMPLOYEE NUMBER, Worker Category, Full Name, الأسم بالعربي, Line Manager, اسم الوظيفة, POSITION NAME, DEPARTMENT NAME, إسم القسم, Sub- Department, القسم الفرعي, line manager UNIQUE EMPLOYEE NUMBER`. Its XML uses the `x:` namespace prefix, which ExcelJS cannot load (confirmed 2026-10-15), hence the hand parser.
- Merge precedence per employee number: `fullNameAr`, `email`, `department`, `category` from the directory, else HR; `fullNameEn`, `positionAr` (HR `اسم الوظيفة`), `supervisorNumber` from HR. Rows with no employee number in either file are excluded. Department passes through `aliases` (exact key → replacement) before output. Sub-departments are dropped (spec decision 3).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { mergeStaff, parseCsv, parseOoxmlSheet } from "./lib.mjs";

describe("parseCsv", () => {
  it("handles BOM, quotes and CRLF", () => {
    expect(parseCsv('\ufeffa,b\r\n"x, y","q""q"\r\n')).toEqual([["a", "b"], ["x, y", 'q"q']]);
  });
});

describe("parseOoxmlSheet", () => {
  it("reads shared strings and inline values from an x:-prefixed sheet with the header on row 2", () => {
    const parts: Record<string, string> = {
      "xl/sharedStrings.xml": '<x:sst xmlns:x="u"><x:si><x:t>NO</x:t></x:si><x:si><x:t>الاسم</x:t></x:si><x:si><x:t>أحمد</x:t></x:si></x:sst>',
      "xl/worksheets/sheet1.xml": '<x:worksheet xmlns:x="u"><x:sheetData><x:row r="1"><x:c r="A1" s="1" /></x:row><x:row r="2"><x:c r="A2" t="s"><x:v>0</x:v></x:c><x:c r="B2" t="s"><x:v>1</x:v></x:c></x:row><x:row r="3"><x:c r="A3"><x:v>24359</x:v></x:c><x:c r="B3" t="s"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    };
    expect(parseOoxmlSheet((n) => parts[n], { headerRow: 2 })).toEqual({ header: ["NO", "الاسم"], rows: [["24359", "أحمد"]] });
  });
});

const dir = (...r: string[][]) => [["الاسم", "البريد", "الإدارة", "المسمّى", "التحويلة", "الفئة", "الرقم الوظيفي", "الحالة"], ...r];
const hr = (...r: string[][]) => ({ header: ["UNIQUE EMPLOYEE NUMBER", "Worker Category", "Full Name", "الأسم بالعربي", "Line Manager", "اسم الوظيفة", "POSITION NAME", "DEPARTMENT NAME", "إسم القسم", "Sub- Department", "القسم الفرعي", "line manager UNIQUE EMPLOYEE NUMBER"], rows: r });

describe("mergeStaff", () => {
  it("joins by employee number, directory wins for identity, HR wins for supervisor and title", () => {
    const { rows, report } = mergeStaff({
      directoryRows: dir(["أحمد", "a@sr.edu.sa", "كلية الطب", "طبيب", "7000", "Academic", "1", "أكّد"], ["صندوق", "dt@sr.edu.sa", "", "", "", "", "", "لم يؤكّد"]),
      hrRows: hr(["1", "Academic", "Ahmed", "احمد (HR)", "Boss", "أستاذ مساعد", "Asst Prof", "College of Medicine", "الطب", "", "", "2"], ["2", "Administrative", "Boss", "الرئيس", "", "رئيس", "President", "Office", "مكتب رئيس الجامعة", "", "", ""]),
      aliases: { "مكتب رئيس الجامعة": "مكتب الرئيس" },
    });
    expect(rows).toEqual([
      { employeeNumber: "1", fullNameAr: "أحمد", fullNameEn: "Ahmed", email: "a@sr.edu.sa", department: "كلية الطب", positionAr: "أستاذ مساعد", category: "Academic", supervisorNumber: "2" },
      { employeeNumber: "2", fullNameAr: "الرئيس", fullNameEn: "Boss", email: null, department: "مكتب الرئيس", positionAr: "رئيس", category: "Administrative", supervisorNumber: null },
    ]);
    expect(report).toMatchObject({ total: 2, excludedNoNumber: 1, withoutEmail: 1, withoutSupervisor: 1, onlyInHr: 1, onlyInDirectory: 0, cycles: [] });
    expect(report.nameConflicts).toEqual(["1: الدليل «أحمد» / الموارد البشرية «احمد (HR)»"]);
  });
  it("lower-cases emails and reports cycles", () => {
    const { rows, report } = mergeStaff({
      directoryRows: dir(["x", "X@SR.EDU.SA", "", "", "", "", "1", ""]),
      hrRows: hr(["1", "", "", "", "", "", "", "", "", "", "", "2"], ["2", "", "", "", "", "", "", "", "", "", "", "1"]),
      aliases: {},
    });
    expect(rows[0].email).toBe("x@sr.edu.sa");
    expect(report.cycles.sort()).toEqual(["1", "2"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/onboarding/lib.test.ts`
Expected: FAIL — cannot resolve `./lib.mjs`.

- [ ] **Step 3: Implement `lib.mjs`**

```js
// Pure helpers for the staff bulk onboarding merge (docs/superpowers/specs/2026-10-15-staff-bulk-onboarding-design.md §4-أ).
export const OUTPUT_HEADERS = ["EMPLOYEE NUMBER", "اسم الموظف", "EMAIL ID", "Employee Name", "الادارة", "اسم الوظيفة", "Category", "الرقم الوظيفي للرئيس المباشر"];

export function parseCsv(text) {
  let raw = text; if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const rows = []; let cur = [], field = "", q = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (q) { if (ch === '"') { if (raw[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { cur.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && raw[i + 1] === "\n") i++; cur.push(field); rows.push(cur); cur = []; field = ""; }
    else field += ch;
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Reads sheet1 of a workbook whose XML uses the `x:` prefix (ExcelJS rejects it). `readPart(name)` returns a zip entry as text. */
export function parseOoxmlSheet(readPart, { headerRow = 1 } = {}) {
  const sst = [...readPart("xl/sharedStrings.xml").matchAll(/<x:si>(.*?)<\/x:si>/gs)]
    .map((m) => unesc([...m[1].matchAll(/<x:t[^>]*>(.*?)<\/x:t>/gs)].map((t) => t[1]).join("")));
  const cells = new Map(); // rowNumber -> { col -> text }
  for (const m of readPart("xl/worksheets/sheet1.xml").matchAll(/<x:c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>(.*?)<\/x:c>)/gs)) {
    const [, col, rn, attrs, inner] = m; if (!inner) continue;
    const v = (inner.match(/<x:v>(.*?)<\/x:v>/s) || [])[1];
    const is = (inner.match(/<x:is>.*?<x:t[^>]*>(.*?)<\/x:t>/s) || [])[1];
    let val = "";
    if (/t="s"/.test(attrs) && v != null) val = sst[Number(v)] ?? ""; else if (is != null) val = unesc(is); else if (v != null) val = unesc(v);
    const r = cells.get(Number(rn)) || {}; r[col] = val.trim(); cells.set(Number(rn), r);
  }
  const colIndex = (c) => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const toArray = (r) => { const arr = []; for (const [c, v] of Object.entries(r)) arr[colIndex(c)] = v; return arr; };
  const header = (toArray(cells.get(headerRow) || {})).map((h) => (h ?? "").trim());
  const rows = [...cells.entries()].filter(([n]) => n > headerRow).sort((a, b) => a[0] - b[0])
    .map(([, r]) => header.map((_, i) => toArray(r)[i] ?? "")).filter((r) => r.some(Boolean));
  return { header, rows };
}

const col = (header, name) => header.findIndex((h) => h.trim() === name);
const clean = (v) => { const t = (v ?? "").trim(); return t === "" ? null : t; };

export function mergeStaff({ directoryRows, hrRows, aliases = {} }) {
  const dh = directoryRows[0]; const d = { no: col(dh, "الرقم الوظيفي"), name: col(dh, "الاسم"), email: col(dh, "البريد"), dept: col(dh, "الإدارة"), pos: col(dh, "المسمّى"), cat: col(dh, "الفئة") };
  const hh = hrRows.header; const h = { no: col(hh, "UNIQUE EMPLOYEE NUMBER"), cat: col(hh, "Worker Category"), nameEn: col(hh, "Full Name"), nameAr: col(hh, "الأسم بالعربي"), title: col(hh, "اسم الوظيفة"), dept: col(hh, "إسم القسم"), lm: col(hh, "line manager UNIQUE EMPLOYEE NUMBER") };
  const byNo = new Map(); let excludedNoNumber = 0;
  for (const r of directoryRows.slice(1)) { const no = clean(r[d.no]); if (!no) { excludedNoNumber++; continue; } byNo.set(no, { dir: r }); }
  for (const r of hrRows.rows) { const no = clean(r[h.no]); if (!no) { excludedNoNumber++; continue; } byNo.set(no, { ...(byNo.get(no) || {}), hr: r }); }
  const rows = []; const nameConflicts = [];
  let withoutEmail = 0, withoutSupervisor = 0, onlyInHr = 0, onlyInDirectory = 0;
  for (const [no, { dir, hr }] of [...byNo.entries()].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }))) {
    if (!dir) onlyInHr++; if (!hr) onlyInDirectory++;
    const dirName = dir ? clean(dir[d.name]) : null, hrName = hr ? clean(hr[h.nameAr]) : null;
    if (dirName && hrName && dirName !== hrName) nameConflicts.push(`${no}: الدليل «${dirName}» / الموارد البشرية «${hrName}»`);
    const rawDept = (dir ? clean(dir[d.dept]) : null) ?? (hr ? clean(hr[h.dept]) : null);
    const email = (dir ? clean(dir[d.email]) : null)?.toLowerCase() ?? null;
    const supervisorNumber = hr ? clean(hr[h.lm]) : null;
    if (!email) withoutEmail++; if (!supervisorNumber) withoutSupervisor++;
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
  const next = new Map(rows.map((r) => [r.employeeNumber, r.supervisorNumber])); const cycles = new Set();
  for (const r of rows) { const seen = new Set(); const path = []; let cur = r.employeeNumber; while (cur && next.has(cur) && !seen.has(cur)) { seen.add(cur); path.push(cur); cur = next.get(cur); } if (cur && seen.has(cur)) for (const n of path.slice(path.indexOf(cur))) cycles.add(n); }
  return { rows, report: { total: rows.length, excludedNoNumber, withoutEmail, withoutSupervisor, onlyInHr, onlyInDirectory, nameConflicts, cycles: [...cycles] } };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run scripts/onboarding/lib.test.ts`
Expected: PASS (4 tests). Also `npx vitest run` still 705+ green (the new file is picked up automatically).

- [ ] **Step 5: Write the CLI `merge-staff.mjs`**

```js
#!/usr/bin/env node
// Usage: node.exe scripts/onboarding/merge-staff.mjs <directory.csv> <line-manager.xlsx> <out.xlsx> [--aliases scripts/onboarding/unit-aliases.json] [--units units.txt]
// Produces one "Employees Data" sheet in the employees import template layout + the supervisor column, and prints the merge report.
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process"; import { createRequire } from "node:module";
import { mergeStaff, parseCsv, parseOoxmlSheet, OUTPUT_HEADERS } from "./lib.mjs";
const require = createRequire(import.meta.url);
const ExcelJS = require(path.join(process.cwd(), "node_modules/exceljs"));
const [csvPath, xlsxPath, outPath, ...flags] = process.argv.slice(2);
if (!csvPath || !xlsxPath || !outPath) { console.error("usage: merge-staff.mjs <directory.csv> <line-manager.xlsx> <out.xlsx> [--aliases f.json] [--units f.txt]"); process.exit(2); }
const flag = (n) => { const i = flags.indexOf(n); return i >= 0 ? flags[i + 1] : null; };
const aliases = flag("--aliases") ? JSON.parse(fs.readFileSync(flag("--aliases"), "utf8")) : {};
const unitNames = flag("--units") ? new Set(fs.readFileSync(flag("--units"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) : null;
const readPart = (name) => execFileSync("unzip", ["-p", xlsxPath, name], { maxBuffer: 1 << 26 }).toString("utf8");
const { rows, report } = mergeStaff({ directoryRows: parseCsv(fs.readFileSync(csvPath, "utf8")), hrRows: parseOoxmlSheet(readPart, { headerRow: 2 }), aliases });
const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Employees Data"); ws.addRow(OUTPUT_HEADERS);
for (const r of rows) ws.addRow([r.employeeNumber, r.fullNameAr, r.email ?? "", r.fullNameEn ?? "", r.department ?? "", r.positionAr ?? "", r.category ?? "", r.supervisorNumber ?? ""]);
await wb.xlsx.writeFile(outPath);
const unknownUnits = unitNames ? [...new Set(rows.map((r) => r.department).filter((u) => u && !unitNames.has(u)))] : null;
console.log(JSON.stringify({ ...report, unknownUnits, output: outPath }, null, 2));
if (report.cycles.length) { console.error("supervisor cycles found — fix the HR file before importing"); process.exit(1); }
```

- [ ] **Step 6: Write `unit-aliases.json` and `README.md`**

`unit-aliases.json` (spec decision 6; "شطر الطالبات" has no unit — leave it out so it is reported as unmatched and the two employees land in the queue for manual placement):
```json
{
  "مكتب رئيس الجامعة": "مكتب الرئيس"
}
```
README: what the two source files are, where they come from (directory export at `dt.sr.edu.sa/directory/` by its admin; HR line-manager workbook), the exact command, what the report fields mean, and the rule that real files never get committed (add `scripts/onboarding/*.csv`, `scripts/onboarding/*.xlsx` to `.gitignore`).

- [ ] **Step 7: Run against the real files and read the report**

Run:
```bash
node.exe scripts/onboarding/merge-staff.mjs "C:/Users/falaieri/Downloads/sru-staff-2026-10-15.csv" "C:/Users/falaieri/Downloads/Line_Manager-with-line-manager.xlsx" "C:/Users/falaieri/Downloads/sru-staff-merged-2026-10-15.xlsx" --aliases scripts/onboarding/unit-aliases.json
```
Expected: `total` ≈ 301, `excludedNoNumber` 14, `withoutEmail` 11, `withoutSupervisor` 5 (president + 4 directory-only), `cycles: []`, exit 0. Open the output with ExcelJS (`loadImportWorkbook`-style) to confirm it parses.

- [ ] **Step 8: Commit**

```bash
git add scripts/onboarding/lib.mjs scripts/onboarding/lib.test.ts scripts/onboarding/merge-staff.mjs scripts/onboarding/unit-aliases.json scripts/onboarding/README.md .gitignore
git commit -m "سكربت دمج ملفي المنسوبين (الدليل + الرؤساء) إلى ورقة استيراد واحدة مع تقرير"
```

---

### Task 4: Employee import library with supervisor pass, approval status, hint, derived roles, dry run

**Files:**
- Create: `src/lib/staffImport.ts` (employee half of the import, extracted; takes a `SupabaseClient`)
- Modify: `src/lib/importColumns.ts:88-114` (add `supervisorNumber`)
- Modify: `src/app/[locale]/(app)/admin/org-structure/import-actions.ts` (sections 1–5b replaced by a call into the library; structure part unchanged; audit gains counters; `dryRun` short-circuits before any write)
- Modify: `src/components/ImportOrgStructureExcelForm.tsx` (field spec + preview rendering)
- Modify: `src/components/ExcelImportDialog.tsx` (optional `previewLabel` prop → second submit button that sets `dryRun=1`)
- Modify: `messages/ar.json`, `messages/en.json` (`ExcelImport.previewButton`, `OrgStructurePage.importFieldSupervisor`, `OrgStructurePage.importPreview*`)
- Test: `tests/integration/staff-import.integration.test.ts`

**Interfaces:**
- Consumes: `placeRows`, `findSupervisorCycles` (Task 2); `profiles.job_title_hint` (Task 1); `parseImportOptions`/`writesField`/`updatesExisting` (existing).
- Produces:
```ts
// src/lib/staffImport.ts
export interface StaffImportRow {            // one parsed "Employees Data" row (parsing stays in the action; this is its output)
  employeeNumber: string; fullNameAr: string; fullNameEn: string | null; email: string | null;
  hireDate: string | null; qualification: string | null; educationSpeciality: string | null; dateOfBirth: string | null;
  mobile: string | null; maritalStatus: string | null; gender: string | null; nationality: string | null;
  departmentAr: string | null; positionAr: string | null; positionEn: string | null; gradeCode: number | null;
  employeeCategory: string | null; insuranceCategory: string | null; roleName: string | null;
  supervisorNumber: string | null;
}
export interface StaffImportSummary {
  employeesUpserted: number; employeeErrors: string[]; rolesAssigned: number; roleErrors: string[];
  unmatchedOrgUnits: string[]; supervisorsLinked: number; unknownSupervisors: string[];
  approvedCreated: number; pendingCreated: number; withoutEmail: number; dryRun: boolean;
}
export async function importStaffRows(supabase: SupabaseClient, rows: StaffImportRow[], options: ImportOptions, actorId: string, dryRun: boolean): Promise<StaffImportSummary>
```
- `ImportResult.summary` (import-actions.ts) gains the new fields; `ORG_STRUCTURE_IMPORT_COLUMNS.supervisorNumber = "الرقم الوظيفي للرئيس المباشر"`.

Behaviour of `importStaffRows` (spec §4-ب):
1. Resolve org units (exact `name_ar`), job families, and **existing profiles** (`employee_number, id, auth_user_id, org_unit_id, email`) in one select each.
2. Titles: existing find-or-create only when `gradeCode != null` (unchanged). Title id for a row = family::name match (unchanged) **or** a unique exact `name_ar` match across all titles; `job_title_hint = positionAr` whenever `positionAr` is set and no id resolved.
3. Email collisions: a row whose email equals an existing profile's email under a **different** employee number is reported (`"<no>: email already used by <otherNo> — skipped"`) and dropped before batching (Review Focus 1). Duplicate numbers inside the file: last row wins, reported.
4. `known` for `placeRows` = file rows (number → resolved org unit id) ∪ existing profiles (number → org_unit_id). Verdicts drive: `approval_status` (`approved`/`pending`) and `created_by: actorId` on **new** rows only.
5. Writes: new rows → `insert` in batches of 50 (with approval_status/created_by); existing rows → `upsert` on `employee_number` only when `updatesExisting(options)`, never carrying approval_status/created_by, and never writing `job_title_id` for an existing row that already has one (Review Focus 3). Rows without email are written with `email: null` (Review Focus: the old "missing email → skipped" rule goes away because `profiles.email` is nullable since 20260725000010).
6. Supervisor pass: after the writes, re-select `profiles(id, employee_number)` for every number in the file ∪ every `supervisorNumber`; group rows by supervisor; one `update({ supervisor_id }).in("employee_number", [...])` per supervisor, restricted to the rows this run wrote (new rows in insert_only mode; all file rows in upsert mode). Self-supervision rows and unknown supervisors go to `unknownSupervisors` / `employeeErrors`. On any cycle in the file, return early with `employeeErrors: ["supervisor cycle: ..."]` and no writes.
7. Roles: `employee` (all), `supervisor` (verdict.isSupervisor), `manager` scoped `org_unit` on `verdict.headOfOrgUnitId`, plus the legacy `roleName` column (by `roles.name_ar`, scope all). Keys for dedup: `${target}::${roleId}::${scope}::${orgUnitId ?? ""}` against existing `user_roles` (linked) / `pending_role_assignments` (unlinked). Insert only the missing ones; never delete.
8. `dryRun`: steps 1–4 run (reads only), then the summary is computed from the verdicts (`approvedCreated`, `pendingCreated`, `unmatchedOrgUnits`, `unknownSupervisors`, `withoutEmail`, would-be `rolesAssigned`) and returned with `dryRun: true`; no insert/update, no audit.

- [ ] **Step 1: Write the failing integration test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { adminClient, env, Fixtures, hasDatabase, type TempUser } from "./helpers";
import { importStaffRows, type StaffImportRow } from "../../src/lib/staffImport";

/** Bulk staff import (spec 2026-10-15): placement verdicts, supervisor pass, derived roles, dry run — through a real super_admin session so RLS is exercised. */
describe.skipIf(!hasDatabase)("importStaffRows", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  const tag = fx.tag;
  let actor: TempUser; let session: ReturnType<typeof createClient>; let unitA: string; let unitB: string;
  const no = (k: string) => `TMPIT-BULK-${k}-${tag}`;
  const row = (k: string, over: Partial<StaffImportRow> = {}): StaffImportRow => ({
    employeeNumber: no(k), fullNameAr: `موظف ${k}`, fullNameEn: null, email: `tmp-it-bulk-${k}-${tag}@sru-dev.internal`, hireDate: null, qualification: null,
    educationSpeciality: null, dateOfBirth: null, mobile: null, maritalStatus: null, gender: null, nationality: null, departmentAr: null, positionAr: null,
    positionEn: null, gradeCode: null, employeeCategory: null, insuranceCategory: null, roleName: null, supervisorNumber: null, ...over,
  });
  const options = { mode: "insert_only" as const, fields: null, mapping: new Map(), ignored: new Set<string>() };

  beforeAll(async () => {
    actor = await fx.user("bulkadmin");
    await admin.from("user_roles").insert({ user_id: actor.authUserId, role_id: await fx.roleId("super_admin"), scope_type: "all" });
    session = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await session.auth.signInWithPassword({ email: actor.email, password: actor.password }); if (error) throw error;
    const { data: units } = await admin.from("org_units").select("id, name_ar").is("deleted_at", null).order("name_ar").limit(2);
    unitA = units![0].name_ar; unitB = units![1].name_ar;
  });
  afterAll(async () => {
    const { data } = await admin.from("profiles").select("id").like("employee_number", `TMPIT-BULK-%-${tag}`);
    if (data?.length) await admin.from("profiles").delete().in("id", data.map((p) => p.id)); // pending_role_assignments cascade
    await fx.cleanup();
  });

  const rows = () => [
    row("root", { departmentAr: unitA }),                                            // president: root, supervises dean
    row("dean", { departmentAr: unitB, supervisorNumber: no("root") }),              // head of unitB
    row("emp", { departmentAr: unitB, supervisorNumber: no("dean"), positionAr: "مسمّى غير موجود" }),
    row("nounit", { departmentAr: "إدارة غير موجودة", supervisorNumber: no("dean") }),
    row("nosup", { departmentAr: unitB, supervisorNumber: no("ghost") }),
    row("noemail", { email: null, departmentAr: unitB, supervisorNumber: no("dean") }),
  ];

  it("dry run reports the plan and writes nothing", async () => {
    const s = await importStaffRows(session, rows(), options, actor.authUserId, true);
    expect(s).toMatchObject({ dryRun: true, approvedCreated: 4, pendingCreated: 2, withoutEmail: 1, unmatchedOrgUnits: ["إدارة غير موجودة"], employeesUpserted: 0 });
    expect(s.unknownSupervisors).toEqual([`${no("nosup")} → ${no("ghost")}`]);
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).like("employee_number", `TMPIT-BULK-%-${tag}`);
    expect(count).toBe(0);
  });

  it("real run: statuses, supervisors, hint and roles", async () => {
    const s = await importStaffRows(session, rows(), options, actor.authUserId, false);
    expect(s).toMatchObject({ dryRun: false, employeesUpserted: 6, approvedCreated: 4, pendingCreated: 2, supervisorsLinked: 4 });
    const { data: p } = await admin.from("profiles").select("employee_number, approval_status, supervisor_id, org_unit_id, job_title_hint, job_title_id, created_by, email").like("employee_number", `TMPIT-BULK-%-${tag}`);
    const by = new Map(p!.map((x) => [x.employee_number, x]));
    expect(by.get(no("root"))!.approval_status).toBe("approved");           // Review Focus 5
    expect(by.get(no("dean"))!.approval_status).toBe("approved");
    expect(by.get(no("nounit"))!.approval_status).toBe("pending");
    expect(by.get(no("nosup"))!.approval_status).toBe("pending");           // Review Focus 2
    expect(by.get(no("noemail"))!.email).toBeNull();
    expect(by.get(no("emp"))!.job_title_hint).toBe("مسمّى غير موجود");
    expect(by.get(no("emp"))!.job_title_id).toBeNull();
    expect(by.get(no("emp"))!.created_by).toBe(actor.authUserId);
    const deanId = (await admin.from("profiles").select("id").eq("employee_number", no("dean")).single()).data!.id;
    expect(by.get(no("emp"))!.supervisor_id).toBe(deanId);
    expect(by.get(no("nosup"))!.supervisor_id).toBeNull();
    // roles (unlinked → pending_role_assignments)
    const { data: pend } = await admin.from("pending_role_assignments").select("profile_id, scope_type, org_unit_id, roles(role_code)").in("profile_id", p!.map((x) => (by.get(x.employee_number) as unknown as { id?: string }).id ?? "")).limit(0);
    void pend;
    const { data: ids } = await admin.from("profiles").select("id, employee_number").like("employee_number", `TMPIT-BULK-%-${tag}`);
    const idOf = (k: string) => ids!.find((x) => x.employee_number === no(k))!.id;
    const { data: pr } = await admin.from("pending_role_assignments").select("profile_id, scope_type, org_unit_id, roles(role_code)").in("profile_id", ids!.map((x) => x.id));
    const codes = (k: string) => pr!.filter((r) => r.profile_id === idOf(k)).map((r) => `${(r.roles as unknown as { role_code: string }).role_code}:${r.scope_type}`).sort();
    expect(codes("emp")).toEqual(["employee:all"]);
    expect(codes("dean")).toEqual(["employee:all", "manager:org_unit", "supervisor:all"]);
    expect(pr!.find((r) => r.profile_id === idOf("dean") && r.scope_type === "org_unit")!.org_unit_id).toBe(by.get(no("dean"))!.org_unit_id);
    expect(codes("root")).toEqual(["employee:all", "manager:org_unit", "supervisor:all"]);
  });

  it("insert_only re-run leaves existing rows alone; upsert updates placement but not status", async () => {   // Review Focus 3
    await admin.from("profiles").update({ approval_status: "approved" }).eq("employee_number", no("nosup"));
    const again = rows().map((r) => (r.employeeNumber === no("nosup") ? { ...r, supervisorNumber: no("dean") } : r));
    const s1 = await importStaffRows(session, again, options, actor.authUserId, false);
    expect(s1.employeesUpserted).toBe(0);
    expect((await admin.from("profiles").select("supervisor_id").eq("employee_number", no("nosup")).single()).data!.supervisor_id).toBeNull();
    const s2 = await importStaffRows(session, again, { ...options, mode: "upsert" }, actor.authUserId, false);
    expect(s2.employeesUpserted).toBe(6);
    const after = (await admin.from("profiles").select("supervisor_id, approval_status").eq("employee_number", no("nosup")).single()).data!;
    expect(after.supervisor_id).not.toBeNull();
    expect(after.approval_status).toBe("approved");
    const pend = (await admin.from("profiles").select("approval_status").eq("employee_number", no("nounit")).single()).data!;
    expect(pend.approval_status).toBe("pending"); // existing status untouched by upsert
  });

  it("email collision is isolated to its row", async () => {   // Review Focus 1
    const clash = row("clash", { email: `tmp-it-bulk-emp-${tag}@sru-dev.internal`, departmentAr: unitB, supervisorNumber: no("dean") });
    const ok = row("ok", { departmentAr: unitB, supervisorNumber: no("dean") });
    const s = await importStaffRows(session, [clash, ok], options, actor.authUserId, false);
    expect(s.employeesUpserted).toBe(1);
    expect(s.employeeErrors.some((e) => e.startsWith(no("clash")))).toBe(true);
  });

  it("self-supervision is reported, never written", async () => {   // Review Focus 4
    const s = await importStaffRows(session, [row("selfie", { departmentAr: unitB, supervisorNumber: no("selfie") })], options, actor.authUserId, false);
    expect(s.pendingCreated).toBe(1);
    expect(s.employeeErrors.some((e) => e.includes("self"))).toBe(true);
  });
});
```
(Remove the stray `limit(0)` probe lines when writing the real file; they are not part of the test.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:integration -- tests/integration/staff-import.integration.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/staffImport`.

- [ ] **Step 3: Add the column key**

In `src/lib/importColumns.ts` after `role: "الدور في النظام",` add:
```ts
  supervisorNumber: "الرقم الوظيفي للرئيس المباشر",
```

- [ ] **Step 4: Implement `src/lib/staffImport.ts`**

Move `EmployeeRow` (renamed `StaffImportRow`, plus `supervisorNumber`) and sections 1–5b of `import-actions.ts` into the library, then apply the behaviour list above. Skeleton with the new parts spelled out (unchanged blocks are carried over verbatim from `import-actions.ts` lines 188–199, 277–305, 385–455):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { updatesExisting, writesField, type ImportOptions } from "@/lib/excelImportOptions";
import { findSupervisorCycles, placeRows, type PlacementRow } from "@/lib/staffPlacement";

export interface StaffImportRow { /* as in Interfaces */ }
export interface StaffImportSummary { /* as in Interfaces */ }

const BATCH_SIZE = 50;

export async function importStaffRows(supabase: SupabaseClient, input: StaffImportRow[], options: ImportOptions, actorId: string, dryRun: boolean): Promise<StaffImportSummary> {
  const employeeErrors: string[] = []; const roleErrors: string[] = []; const unknownSupervisors: string[] = [];
  const unmatched = new Set<string>();
  const empty = (): StaffImportSummary => ({ employeesUpserted: 0, employeeErrors, rolesAssigned: 0, roleErrors, unmatchedOrgUnits: [...unmatched], supervisorsLinked: 0, unknownSupervisors, approvedCreated: 0, pendingCreated: 0, withoutEmail: 0, dryRun });

  // Duplicate numbers inside the file: last wins, reported.
  const byNumber = new Map<string, StaffImportRow>();
  for (const r of input) { if (byNumber.has(r.employeeNumber)) employeeErrors.push(`${r.employeeNumber}: duplicated in file — last row used`); byNumber.set(r.employeeNumber, r); }
  const rows = [...byNumber.values()];

  const cycles = findSupervisorCycles(rows.map((r) => ({ employeeNumber: r.employeeNumber, orgUnitId: null, supervisorNumber: r.supervisorNumber })));
  if (cycles.length) { employeeErrors.push(`supervisor cycle: ${cycles.join(", ")} — nothing imported`); return empty(); }

  // 1. reference data
  const { data: orgUnitsData } = await supabase.from("org_units").select("id, name_ar").is("deleted_at", null);
  const orgUnitByName = new Map((orgUnitsData ?? []).map((u) => [u.name_ar.trim(), u.id]));
  const { data: familiesData } = await supabase.from("job_families").select("id, name_ar");
  const academicFamilyId = familiesData?.find((f) => f.name_ar === "الأكاديمي")?.id ?? null;
  const generalFamilyId = familiesData?.find((f) => f.name_ar === "عام")?.id ?? null;
  const { data: existingData } = await supabase.from("profiles").select("id, employee_number, auth_user_id, org_unit_id, email, job_title_id").is("deleted_at", null);
  const existing = new Map((existingData ?? []).map((p) => [p.employee_number, p]));
  const emailOwner = new Map((existingData ?? []).filter((p) => p.email).map((p) => [p.email as string, p.employee_number]));

  // 2. titles (find-or-create only with a grade; unchanged) + unique-name match + hint
  // ... carry over lines 277–305 (guarded by !dryRun for the upsert) ...
  const { data: allTitles } = await supabase.from("job_titles").select("id, job_family_id, name_ar").is("deleted_at", null);
  const titleIdByKey = new Map((allTitles ?? []).map((t) => [`${t.job_family_id}::${t.name_ar}`, t.id]));
  const titleIdsByName = new Map<string, string[]>();
  for (const t of allTitles ?? []) titleIdsByName.set(t.name_ar.trim(), [...(titleIdsByName.get(t.name_ar.trim()) ?? []), t.id]);
  const resolveTitle = (r: StaffImportRow): string | null => {
    if (!r.positionAr) return null;
    const isAcademic = r.employeeCategory?.toLowerCase().startsWith("academic") ?? false;
    const familyId = isAcademic ? academicFamilyId : generalFamilyId;
    const byFamily = familyId ? titleIdByKey.get(`${familyId}::${r.positionAr}`) : undefined;
    if (byFamily) return byFamily;
    const byName = titleIdsByName.get(r.positionAr.trim());
    return byName && byName.length === 1 ? byName[0] : null;
  };

  // 3. email collisions + 4. verdicts
  const accepted = rows.filter((r) => {
    const owner = r.email ? emailOwner.get(r.email) : undefined;
    if (owner && owner !== r.employeeNumber) { employeeErrors.push(`${r.employeeNumber}: email already used by ${owner} — skipped`); return false; }
    return true;
  });
  const unitOf = (r: StaffImportRow) => { const id = r.departmentAr ? orgUnitByName.get(r.departmentAr) ?? null : null; if (r.departmentAr && !id) unmatched.add(r.departmentAr); return id; };
  const placement: PlacementRow[] = accepted.map((r) => ({ employeeNumber: r.employeeNumber, orgUnitId: unitOf(r), supervisorNumber: r.supervisorNumber }));
  const known = new Map<string, { orgUnitId: string | null }>();
  for (const [n, p] of existing) known.set(n, { orgUnitId: p.org_unit_id });
  for (const p of placement) known.set(p.employeeNumber, { orgUnitId: p.orgUnitId });
  const verdicts = placeRows(placement, known);
  for (const r of accepted) {
    const v = verdicts.get(r.employeeNumber)!;
    if (v.selfSupervision) employeeErrors.push(`${r.employeeNumber}: supervisor is self — left without supervisor`);
    else if (r.supervisorNumber && !v.supervisorResolved) unknownSupervisors.push(`${r.employeeNumber} → ${r.supervisorNumber}`);
  }
  const isNew = (r: StaffImportRow) => !existing.has(r.employeeNumber);
  const willWrite = (r: StaffImportRow) => isNew(r) || updatesExisting(options);
  const approvedCreated = accepted.filter((r) => isNew(r) && verdicts.get(r.employeeNumber)!.approved).length;
  const pendingCreated = accepted.filter((r) => isNew(r) && !verdicts.get(r.employeeNumber)!.approved).length;
  const withoutEmail = accepted.filter((r) => willWrite(r) && !r.email).length;

  // 7 (planned roles are counted the same way in both modes) — build role plan now, write later
  // ... see step list: role plan = for each accepted row that willWrite(): employee; +supervisor if v.isSupervisor; +manager/org_unit if v.headOfOrgUnitId; +legacy roleName

  if (dryRun) return { ...empty(), approvedCreated, pendingCreated, withoutEmail, rolesAssigned: plannedRoleCount };

  // 5. writes — new rows via insert (with approval_status/created_by), existing via upsert (only in upsert mode)
  // row builder: same optional-field mapping as the old code (writesField), plus:
  //   job_title_id only when resolved; for an EXISTING row with job_title_id already set, do not send job_title_id at all;
  //   job_title_hint = positionAr when positionAr && !resolvedTitle (always sent for new rows; for existing rows only when writesField(options,"positionAr"));
  //   email: r.email (may be null).
  // 6. supervisor pass (grouped update per supervisor, restricted to willWrite rows, skipping selfSupervision/unresolved)
  // 7. role writes (dedup against existing user_roles / pending_role_assignments incl. org_unit scope; assigned_by: actorId on pending rows)
  // return full summary
}
```
Write the real implementation in full (no "..." left in the file); the three "carry over" blocks are the existing code moved as-is.

- [ ] **Step 5: Rewire `import-actions.ts`**

- Delete sections 1–5b; keep parsing (`EmployeeRow` → `StaffImportRow`, add `supervisorNumber: cellText(get(row, "الرقم الوظيفي للرئيس المباشر"))`), drop the `!email` part of the "missing required" check (name still required), and after parsing call:
```ts
const dryRun = formData.get("dryRun") === "1";
const staff = employeesSheet ? await importStaffRows(supabase, employeeRows, options, actor.id, dryRun) : null;
if (dryRun) return { status: "success", summary: { ...emptyStructureCounters, ...(staff ?? emptyStaff), dryRun: true } };
```
- The structure block stays; it already re-selects `profiles` by number for staffing.
- Audit `after_data` gains `supervisorsLinked, approvedCreated, pendingCreated, unknownSupervisorCount, dryRun:false`.
- `ImportResult.summary` type gains the new fields (`supervisorsLinked, unknownSupervisors, approvedCreated, pendingCreated, withoutEmail, dryRun`).

- [ ] **Step 6: Dialog preview button + outcome rendering**

`ExcelImportDialog.tsx`: new optional prop `previewLabel?: string`. In the step-2 form (and the step-1 form when `!hasMappableFields`), render beside the primary submit:
```tsx
{previewLabel && (
  <button type="button" className="sru-btn" disabled={!file || importing} onClick={() => submit(true)}>{previewLabel}</button>
)}
```
where `submit(dryRun)` builds the same FormData as the form's `onSubmit` and sets `formData.set("dryRun", "1")` when `dryRun`. Refactor the existing inline `onSubmit` bodies into that `submit(false)` helper so both paths build identical FormData.

`ImportOrgStructureExcelForm.tsx`: add `{ key: "supervisorNumber", label: t("importFieldSupervisor"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.supervisorNumber }` to `fields`; pass `previewLabel={t("importPreviewButton")}`; in `OrgStructureImportOutcome`, when `state.summary.dryRun` render:
```tsx
<p role="status">{t("importPreviewSummary", { approved: s.approvedCreated, pending: s.pendingCreated, noEmail: s.withoutEmail, roles: s.rolesAssigned })}</p>
```
followed by the existing unmatched-units list and a new `<details>` for `unknownSupervisors` (`importUnknownSupervisors`), and skip `router.refresh()` for dry runs. For real runs add the same two lists under the success line (`importSuccessPlacement`: "{linked} رئيسًا مباشرًا مرتبطًا، {approved} معتمد، {pending} بانتظار الإسناد").

Messages (ar / en):
- `ExcelImport.previewButton`: "معاينة بلا كتابة" / "Preview (no changes)"
- `OrgStructurePage.importFieldSupervisor`: "الرقم الوظيفي للرئيس المباشر" / "Line manager employee number"
- `OrgStructurePage.importPreviewButton`: same text as previewButton
- `OrgStructurePage.importPreviewSummary`: "معاينة: سيُعتمد {approved} موظفًا، ويُعلَّق {pending} بانتظار الإسناد، {noEmail} بلا بريد، {roles} دورًا سيُسند. لم يُكتب شيء." / EN equivalent
- `OrgStructurePage.importSuccessPlacement`: "{linked} رئيسًا مباشرًا مرتبطًا، {approved} معتمدًا، {pending} بانتظار الإسناد." / EN
- `OrgStructurePage.importUnknownSupervisors`: "رؤساء مباشرون غير موجودين ({count})" / "Unknown line managers ({count})"

- [ ] **Step 7: Type-check, lint, unit + integration tests**

Run: `npx tsc --noEmit && npx eslint src/lib/staffImport.ts "src/app/[locale]/(app)/admin/org-structure/import-actions.ts" src/components/ExcelImportDialog.tsx src/components/ImportOrgStructureExcelForm.tsx && npx vitest run && npm run test:integration -- tests/integration/staff-import.integration.test.ts`
Expected: all green; integration 5 tests pass. Also run the existing `excelImportOptions` / `importColumns` unit tests (part of `vitest run`) — adding a key must not break the "every column label is unique" style tests if any exist.

- [ ] **Step 8: Commit**

```bash
git add src/lib/staffImport.ts src/lib/importColumns.ts "src/app/[locale]/(app)/admin/org-structure/import-actions.ts" src/components/ExcelImportDialog.tsx src/components/ImportOrgStructureExcelForm.tsx messages/ar.json messages/en.json tests/integration/staff-import.integration.test.ts
git commit -m "استيراد الموظفين: الرئيس المباشر، حالة الاعتماد الصريحة، تلميح المسمّى، الأدوار المشتقّة، والمعاينة بلا كتابة"
```

---

### Task 5: Approval with placement + editable employee number

**Files:**
- Modify: `src/app/[locale]/(app)/employees/actions.ts:63-136` (`reviewEmployeeApproval` accepts optional placement)
- Modify: `src/components/EmployeeApprovalActions.tsx` (selects for unit / title / supervisor, hint display)
- Modify: `src/app/[locale]/(app)/employees/page.tsx:66-67, 79-95, 309-340` (select `job_title_hint, job_title_id, org_unit_id`; fetch job titles + approved supervisor candidates; pass to the row component)
- Modify: `src/app/[locale]/(app)/employees/[id]/edit/actions.ts:7-35, 93-119` (`employeeNumber`)
- Modify: `src/components/EditEmployeeForm.tsx:126-129` (enable the input, `name="employeeNumber"`)
- Modify: `messages/ar.json`, `messages/en.json` (`EmployeesPage.columnPlacement`, `EmployeesPage.hintTitle`, `EmployeesPage.placeholderKeep`, `EmployeesPage.placeholderNone`)
- Test: `src/app/[locale]/(app)/employees/actions.test.ts` (Zod schema only) — add `reviewApprovalSchema` export and test it; DB behaviour verified live in Task 7.

**Interfaces:**
- `reviewApprovalSchema` gains `orgUnitId?: uuid`, `jobTitleId?: uuid`, `supervisorId?: uuid` (empty string → undefined). On `decision === "approved"`, the update payload is `{ approval_status, ...(orgUnitId && { org_unit_id }), ...(jobTitleId && { job_title_id }), ...(supervisorId && { supervisor_id }) }`; `check_vpra('employeeData','approve', orgUnitId ?? target.org_unit_id)` must pass for the **new** unit (and, when the unit changes, for the old one too — a scoped approver must not move someone out of their own scope into another). `supervisorId === profileId` → `invalid_input`.
- `EmployeeApprovalActions` props: `{ profileId, hint: { orgUnitId, jobTitleId, jobTitleHint, supervisorId }, orgUnits: {id,name_ar}[], jobTitles: {id,name_ar}[], supervisors: {id,full_name_ar,employee_number}[] }`.
- `updateEmployee` schema gains `employeeNumber: z.string().trim().min(1).max(32)`; payload writes `employee_number`; 23505 → `duplicate` (already handled).

- [ ] **Step 1: Write the failing schema test**

```ts
import { describe, expect, it } from "vitest";
import { reviewApprovalSchema } from "./actions";
describe("reviewApprovalSchema", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  it("accepts a bare decision", () => { expect(reviewApprovalSchema.safeParse({ profileId: id, decision: "approved" }).success).toBe(true); });
  it("turns empty placement strings into undefined", () => {
    const r = reviewApprovalSchema.safeParse({ profileId: id, decision: "approved", orgUnitId: "", jobTitleId: "", supervisorId: "" });
    expect(r.success && r.data.orgUnitId).toBeUndefined();
  });
  it("rejects a supervisor equal to the profile", () => {
    expect(reviewApprovalSchema.safeParse({ profileId: id, decision: "approved", supervisorId: id }).success).toBe(false);
  });
});
```
Note: `actions.ts` is `"use server"`; exporting a non-async value from a server-action file is rejected by Next. Put the schema in `src/app/[locale]/(app)/employees/approvalSchema.ts` (plain module) and import it from `actions.ts` and the test.

- [ ] **Step 2: Run to verify failure** — `npx vitest run "src/app/[locale]/(app)/employees/approvalSchema.test.ts"` → FAIL (module missing).

- [ ] **Step 3: Implement schema, action, components, page, edit form**

`approvalSchema.ts`:
```ts
import { z } from "zod";
const optionalUuid = z.string().trim().optional().transform((v) => (v ? v : undefined)).pipe(z.string().uuid().optional());
export const reviewApprovalSchema = z.object({
  profileId: z.string().uuid(), decision: z.enum(["approved", "rejected"]),
  orgUnitId: optionalUuid, jobTitleId: optionalUuid, supervisorId: optionalUuid,
}).refine((d) => d.supervisorId !== d.profileId, { path: ["supervisorId"] });
```
`reviewEmployeeApproval`: parse the three extra fields from `formData`; after the existing `canApprove` on `target.org_unit_id`, if `orgUnitId && orgUnitId !== target.org_unit_id` run a second `check_vpra` on `orgUnitId`; build the payload as in Interfaces; audit `after_data` includes the placement fields.

`EmployeeApprovalActions.tsx`: three `<select>` elements (name `orgUnitId` default `hint.orgUnitId ?? ""`, `jobTitleId` default `hint.jobTitleId ?? ""`, `supervisorId` default `hint.supervisorId ?? ""`), each with a first option `placeholderKeep` (""), and the hint text under the title select when `hint.jobTitleHint` (`hintTitle`: "المسمّى في الملف: {hint}"). Keep the two icon buttons.

`page.tsx`: `selectColumns` adds `org_unit_id, job_title_id, job_title_hint`; add to the `Promise.all` two more queries: `supabase.from("job_titles").select("id, name_ar").is("deleted_at", null).order("name_ar")` and `supabase.from("profiles").select("id, full_name_ar, employee_number").is("deleted_at", null).eq("approval_status", "approved").order("full_name_ar")` (RLS-scoped; fine). Pending table gets a `columnPlacement` header and passes the lists + hint to the row component.

Edit form/action: enable the input (`name="employeeNumber"`, `required`), schema + payload as in Interfaces.

- [ ] **Step 4: Verify** — `npx vitest run "src/app/[locale]/(app)/employees/approvalSchema.test.ts"` PASS; `npx tsc --noEmit`; `npx eslint` on touched files.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(app)/employees/approvalSchema.ts" "src/app/[locale]/(app)/employees/approvalSchema.test.ts" "src/app/[locale]/(app)/employees/actions.ts" src/components/EmployeeApprovalActions.tsx "src/app/[locale]/(app)/employees/page.tsx" "src/app/[locale]/(app)/employees/[id]/edit/actions.ts" src/components/EditEmployeeForm.tsx messages/ar.json messages/en.json
git commit -m "اعتماد الموظف المعلّق مع إسناد الوحدة والمسمّى والرئيس في الخطوة نفسها، والرقم الوظيفي قابل للتعديل"
```

---

### Task 6: Template, docs, HANDOVER

**Files:**
- Modify: `public/templates/sru-employees-import-template.xlsx` (binary; add the supervisor column header to "Employees Data" + one line in both instruction sheets) via a one-off script `scripts/onboarding/update-template.mjs` (ExcelJS reads/writes this standard workbook fine)
- Modify: `HANDOVER.md` (dated entry after the SSO switch-account entry)
- Modify: `docs/sso-integration.md` (one paragraph: how bulk-loaded profiles meet SSO first login)

- [ ] **Step 1: `update-template.mjs`** — open the template, find the "Employees Data" sheet, append header cell `الرقم الوظيفي للرئيس المباشر` after the last header, append to "تعليمات عربي" a row "الرقم الوظيفي للرئيس المباشر: اختياري؛ الرقم الوظيفي لرئيس الموظف كما في العمود الأول. صف بلا رئيس (أو برئيس غير موجود) يُنشأ بانتظار الإسناد." and to "Instructions" the English equivalent; save. Run it once; verify with `loadImportWorkbook`-style read that the header exists.
- [ ] **Step 2: HANDOVER entry** (Arabic, dated 2026-10-15, same style as the existing entries): decision, what was built (the three units), verification numbers, what remains (live load, production later).
- [ ] **Step 3: Commit** — `git commit -m "قالب الاستيراد: عمود الرئيس المباشر؛ HANDOVER: التحميل الجماعي للمنسوبين"`.

---

### Task 7: Live run on the dev deployment

- [ ] **Step 1: Merge branch** `feat/staff-bulk-onboarding` into `integration/all-priorities-2026-10`, push both; redeploy Netlify from `C:\SRU\deploy-src` (fresh `deploy-site` command; `git fetch --depth 1 origin integration/all-priorities-2026-10 && git reset --hard FETCH_HEAD`). Apply the migration from Task 1 to the dev DB first (it is already applied in Task 1 step 2; confirm).
- [ ] **Step 2: Add the two org units** on the dev DB through `/org-units` (or SQL inside BEGIN/COMMIT with a SELECT check): «كلية العلوم التطبيقية» under «عمداء الكليات», «قسم المهارات والمعارف الأساسية» under «النائب المساعد للتميز الأكاديمي» (parent choice per the directory grouping; kind `college` / `section`). Record ids in HANDOVER.
- [ ] **Step 3: Produce the merged file** (Task 3 step 7) with `--units` pointing at a text export of `org_units.name_ar` so the report lists unknown units before upload.
- [ ] **Step 4: Preview on the site** as `admin`: `/employees` → استيراد من إكسل → file → التالي → «معاينة بلا كتابة». Expected: approved ≈ 280, pending ≈ 20 (2 شطر الطالبات + 4 directory-only without supervisor + 11 without email are still approved if unit+supervisor resolve — email is not a placement field), unknown supervisors 0, unmatched units only «شطر الطالبات».
- [ ] **Step 5: Run for real** (upsert mode so the two existing dev profiles `f.alaieri` / `dt@` get placed). Verify with a DB query: counts by approval_status, `supervisor_id` non-null ≈ 296, pending_role_assignments ≈ 300 employee + 32 supervisor + ~30 manager.
- [ ] **Step 6: SSO check**: the owner logs in with the university account → dashboard shows unit + title hint absent/role line; `/evaluations/team` for a supervisor account (owner's own: head of إدارة التحول الرقمي) lists their reports. Report back with screenshots/queries.
- [ ] **Step 7: HANDOVER** addendum with the real numbers; commit; push.
