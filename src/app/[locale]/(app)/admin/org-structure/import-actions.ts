"use server";

import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ORG_STRUCTURE_IMPORT_COLUMNS } from "@/lib/importColumns";
import { applyMapping, parseImportOptions } from "@/lib/excelImportOptions";
import { cellText, headerMap, loadImportWorkbook } from "@/lib/excelImport";
import { importStaffRows, type StaffImportRow, type StaffImportSummary } from "@/lib/staffImport";

export type ImportResult =
  | {
      status: "success";
      summary: {
        employeesUpserted: number;
        employeeErrors: string[];
        rolesAssigned: number;
        roleErrors: string[];
        levelsCreated: number;
        positionsUpserted: number;
        positionErrors: string[];
        assignmentsCreated: number;
        assignmentErrors: string[];
        unmatchedOrgUnits: string[];
        corrections: string[];
        /** 2026-10-15 staff bulk onboarding — see src/lib/staffImport.ts. */
        supervisorsLinked: number;
        unknownSupervisors: string[];
        approvedCreated: number;
        pendingCreated: number;
        withoutEmail: number;
        /** True when the caller asked for a preview: nothing was written, no audit row. */
        dryRun: boolean;
      };
    }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "forbidden" | "unknown" };

// Known, project-owner-confirmed correction (2026-07-24): the source
// sheet's row for "رئيس قسم القيادة والتنمية الطلابية" references parent
// code 1132, which does not exist anywhere in the sheet — a typo for 1131
// ("مدير إدارة الحياة الجامعية"), confirmed directly by the project owner.

const KNOWN_PARENT_CODE_CORRECTIONS: Record<string, string> = {
  "1132": "1131",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Parses a date cell that may arrive as a real Date (exceljs represents
 * spreadsheet dates as UTC-midnight Date objects), an Excel serial number
 * (some rows in the source sheet aren't actually formatted as dates), or a
 * "DD-MMM-YYYY" string (other rows in the same column). Deliberately reads
 * UTC components / uses an explicit regex rather than `new Date(str)` +
 * `toISOString()` — the naive approach shifts the calendar day backward
 * for any positive UTC offset (confirmed live: `new Date("14-Sep-2012")`
 * .toISOString() yields "2012-09-13" in this environment).
 */
function parseDateCell(value: ExcelJS.CellValue): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  if (typeof value === "number") {
    const utcMillis = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(utcMillis);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  const text = cellText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const monthNames: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const m = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const month = monthNames[m[2].toLowerCase()];
    if (month) return `${m[3]}-${pad2(month)}-${pad2(parseInt(m[1], 10))}`;
  }
  return null;
}

function requireColumns(map: Map<string, number>, names: string[]): string | null {
  for (const name of names) {
    if (!map.has(name)) return name;
  }
  return null;
}

/**
 * Imports the project owner's real org chart workbook (2026-07-24): sheet
 * "Employees Data" (employee master data, upserted by employee_number) and
 * sheet "الهيكل التنظيمي" (levels + positions + staffing, all three in one
 * row per position) — EITHER sheet alone is valid, at least one is required
 * (2026-07-24 follow-up): the Employees page's template has no structure
 * sheet, and the org-structure page's template has no "Employees Data"
 * sheet (removed at the project owner's explicit request, since staffing
 * there resolves against employees that already exist in the database by
 * employee_number). When both sheets ARE present, they're processed
 * together in one action since the structure sheet's staffing column
 * references employees by number — the employees must exist first.
 *
 * Every write goes through the caller's own RLS-respecting client, exactly
 * like every other Server Action in this app — real authorization is
 * `profiles`/`user_roles`/`pending_role_assignments`/`org_structure_*`'s
 * own RLS (`employeeData`/`userManagement`/`orgStructure` approve level),
 * not this action's code. The admin client is used only for `audit_log`,
 * which has no INSERT policy for `authenticated`.
 */
export async function importOrgStructureExcel(
  _prevState: ImportResult | null,
  formData: FormData
): Promise<ImportResult> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "invalid_input" };
  }

  const supabase = await createClient();
  const {
    data: { user: actor },
  } = await supabase.auth.getUser();
  if (!actor) {
    return { status: "error", message: "unauthenticated" };
  }

  // Size and row limits are enforced here, not only in the preview dialog
  // (src/lib/excelImport.ts). A limit the import itself does not check is
  // no limit, since this action can be called directly with any file.
  const loaded = await loadImportWorkbook(file);
  if (!loaded.ok) return { status: "error", message: "invalid_input" };
  const workbook = loaded.workbook;

  const employeesSheet =
    workbook.worksheets.find((w) => w.name.trim() === "Employees Data") ??
    workbook.worksheets.find((w) => /employee/i.test(w.name));
  const structureSheet =
    workbook.worksheets.find((w) => w.name.trim() === "الهيكل التنظيمي") ??
    workbook.worksheets.find((w) => w.name.includes("هيكل"));

  // Neither sheet present at all — nothing to import. Either sheet ALONE is
  // valid: the Employees page's template has only "Employees Data" (no
  // structure sheet, already supported), and the org-structure page's
  // template (2026-07-24 follow-up) now has only "الهيكل التنظيمي" — the
  // project owner explicitly asked for the "Employees Data" sheet to be
  // removed from that specific template, since staffing there resolves
  // against employees that already exist in the database by employee_number.
  if (!employeesSheet && !structureSheet) {
    return { status: "error", message: "invalid_input" };
  }

  const options = parseImportOptions(formData);
  const empCols = employeesSheet
    ? applyMapping(headerMap(employeesSheet), options, ORG_STRUCTURE_IMPORT_COLUMNS)
    : null;
  if (empCols) {
    const missingEmpCol = requireColumns(empCols, [
      "EMPLOYEE NUMBER",
      "اسم الموظف",
      "EMAIL ID",
    ]);
    if (missingEmpCol) {
      return { status: "error", message: "invalid_input" };
    }
  }

  const structCols = structureSheet
    ? applyMapping(headerMap(structureSheet), options, ORG_STRUCTURE_IMPORT_COLUMNS)
    : null;
  if (structCols) {
    const missingStructCol = requireColumns(structCols, [
      "المستوى",
      "الرمز",
      "الوحدة التنظيمية",
    ]);
    if (missingStructCol) {
      return { status: "error", message: "invalid_input" };
    }
  }

  const positionErrors: string[] = [];
  const assignmentErrors: string[] = [];
  const corrections: string[] = [];

  // ---------------------------------------------------------------------
  // 1. Parse "Employees Data" rows. Everything that used to follow here —
  //    org-unit matching, job titles, the profiles upsert and the role
  //    column — lives in src/lib/staffImport.ts since 2026-10-15, together
  //    with the supervisor pass, the explicit approval status, the title
  //    hint, the derived roles and the dry run.
  // ---------------------------------------------------------------------
  const employeeRows: StaffImportRow[] = [];
  const missingName: string[] = [];

  if (employeesSheet && empCols) {
    const cols = empCols;
    const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);

    for (let r = 2; r <= employeesSheet.rowCount; r++) {
      const row = employeesSheet.getRow(r);
      const employeeNumber = cellText(get(row, "EMPLOYEE NUMBER"));
      if (!employeeNumber) continue;

      const fullNameAr = cellText(get(row, "اسم الموظف"));
      // Email is optional since profiles.email dropped its NOT NULL
      // (20260725000010): an HR row without a mailbox still gets a profile; it
      // just cannot sign in through SSO until the directory carries it.
      const email = cellText(get(row, "EMAIL ID"))?.toLowerCase() ?? null;
      if (!fullNameAr) {
        missingName.push(employeeNumber + ": missing required name — skipped");
        continue;
      }

      const gradeRaw = cellText(get(row, "GRADE CODE"));
      const grade = gradeRaw ? parseInt(gradeRaw, 10) : null;

      employeeRows.push({
        employeeNumber,
        fullNameAr,
        fullNameEn: cellText(get(row, "Employee Name")),
        email,
        hireDate: parseDateCell(get(row, "Hire Date")),
        qualification: cellText(get(row, "Qualification")),
        educationSpeciality: cellText(get(row, "Education Speciality")),
        dateOfBirth: parseDateCell(get(row, "DATE OF BIRTH (YYYY-MM-DD)")),
        mobile: cellText(get(row, "Mobile")),
        maritalStatus: cellText(get(row, "MARITIAL STATUS")),
        gender: cellText(get(row, "GENDER")),
        nationality: cellText(get(row, "NATIONALITY")),
        departmentAr: cellText(get(row, "الادارة")),
        positionAr: cellText(get(row, "اسم الوظيفة")),
        positionEn: cellText(get(row, "POSITION")),
        gradeCode: grade != null && !isNaN(grade) ? grade : null,
        employeeCategory: cellText(get(row, "Category"))?.trim() ?? null,
        insuranceCategory: cellText(get(row, "Insurance Category")),
        roleName: cellText(get(row, "الدور في النظام")),
        supervisorNumber: cellText(get(row, ORG_STRUCTURE_IMPORT_COLUMNS.supervisorNumber)),
      });
    }
  }

  const dryRun = formData.get("dryRun") === "1";
  const emptyStaff: StaffImportSummary = {
    employeesUpserted: 0, employeeErrors: [], rolesAssigned: 0, roleErrors: [], unmatchedOrgUnits: [],
    supervisorsLinked: 0, unknownSupervisors: [], approvedCreated: 0, pendingCreated: 0, withoutEmail: 0, dryRun,
  };
  const staff = employeeRows.length > 0 ? await importStaffRows(supabase, employeeRows, options, actor.id, dryRun) : emptyStaff;
  const employeeErrors = [...missingName, ...staff.employeeErrors];
  const roleErrors = staff.roleErrors;
  const employeesUpserted = staff.employeesUpserted;
  const rolesAssigned = staff.rolesAssigned;
  const unmatchedOrgUnitsSet = new Set(staff.unmatchedOrgUnits);
  const BATCH_SIZE = 50;

  if (dryRun) {
    return {
      status: "success",
      summary: {
        employeesUpserted: 0, employeeErrors, rolesAssigned: staff.rolesAssigned, roleErrors,
        levelsCreated: 0, positionsUpserted: 0, positionErrors: [], assignmentsCreated: 0, assignmentErrors: [],
        unmatchedOrgUnits: [...unmatchedOrgUnitsSet], corrections: [],
        supervisorsLinked: 0, unknownSupervisors: staff.unknownSupervisors, approvedCreated: staff.approvedCreated,
        pendingCreated: staff.pendingCreated, withoutEmail: staff.withoutEmail, dryRun: true,
      },
    };
  }

  // -----------------------------------------------------------------------
  // 6-8. Org structure (levels/positions/staffing) — entirely optional
  //      (2026-07-24 follow-up): the Employees page's dedicated template
  //      has no "الهيكل التنظيمي" sheet at all, so this whole block simply
  //      does not run when `structureSheet`/`structCols` are absent.
  // -----------------------------------------------------------------------
  let levelsCreated = 0;
  let positionsUpserted = 0;
  let assignmentsCreated = 0;

  if (structureSheet && structCols) {
    // 6. org_structure_levels — one row per distinct level number, named
    //    "المستوى N" only when not already present (never overwrite a name
    //    the project owner already gave a level through the UI).
    const structGet = (row: ExcelJS.Row, col: string) =>
      structCols.has(col) ? row.getCell(structCols.get(col)!).value : null;

    interface StructRow {
      level: number;
      code: string;
      nameAr: string;
      nameEn: string | null;
      parentCode: string | null;
      employeeNumber: string | null;
    }

    const structRows: StructRow[] = [];
    for (let r = 2; r <= structureSheet.rowCount; r++) {
      const row = structureSheet.getRow(r);
      const code = cellText(structGet(row, "الرمز"));
      const nameAr = cellText(structGet(row, "الوحدة التنظيمية"));
      const levelText = cellText(structGet(row, "المستوى"));
      if (!code || !nameAr || !levelText) continue;

      let parentCode = cellText(structGet(row, "رمز التبعية"));
      if (parentCode && KNOWN_PARENT_CODE_CORRECTIONS[parentCode]) {
        corrections.push(`position ${code} ("${nameAr}"): parent code ${parentCode} corrected to ${KNOWN_PARENT_CODE_CORRECTIONS[parentCode]}`);
        parentCode = KNOWN_PARENT_CODE_CORRECTIONS[parentCode];
      }

      structRows.push({
        level: parseInt(levelText, 10),
        code,
        nameAr,
        nameEn: cellText(structGet(row, "Organizational Unit")),
        parentCode,
        employeeNumber: cellText(structGet(row, "الرقم الوظيفي لمن يشغل المنصب")),
      });
    }

    const { data: existingLevels } = await supabase
      .from("org_structure_levels")
      .select("id, level_order")
      .is("deleted_at", null);
    const levelIdByOrder = new Map((existingLevels ?? []).map((l) => [l.level_order, l.id]));

    const distinctLevelOrders = [...new Set(structRows.map((s) => s.level))].sort((a, b) => a - b);
    const newLevelOrders = distinctLevelOrders.filter((n) => !levelIdByOrder.has(n));
    if (newLevelOrders.length > 0) {
      const { data: inserted, error } = await supabase
        .from("org_structure_levels")
        .insert(newLevelOrders.map((n) => ({ name_ar: `المستوى ${n}`, level_order: n })))
        .select("id, level_order");
      if (error) {
        positionErrors.push(`levels: ${error.message}`);
      } else {
        levelsCreated = inserted?.length ?? 0;
        for (const l of inserted ?? []) levelIdByOrder.set(l.level_order, l.id);
      }
    }

    // 7. org_structure_positions — pass 1 creates/updates every position by
    //    external_code WITHOUT parent_id (parent codes may not have a
    //    matching row yet within this same import); pass 2 resolves and
    //    writes parent_id once every position exists.
    //
    //    Deliberately NOT `.upsert()`: `external_code`'s uniqueness is a
    //    PARTIAL index (`WHERE external_code IS NOT NULL AND deleted_at IS
    //    NULL`), which PostgREST's `on_conflict` inference can't target —
    //    confirmed live (`there is no unique or exclusion constraint
    //    matching the ON CONFLICT specification`), the exact same limitation
    //    already documented for `evaluation_scores`/`calibration_results`.
    //    Select existing codes first, then INSERT the new ones in a batch
    //    and UPDATE changed ones individually, same as those two tables.
    const { data: existingPositionsByCode } = await supabase
      .from("org_structure_positions")
      .select("id, external_code")
      .is("deleted_at", null)
      .not("external_code", "is", null);
    const positionIdByCode = new Map((existingPositionsByCode ?? []).map((p) => [p.external_code as string, p.id]));

    const toInsert: { external_code: string; level_id: string; name_ar: string; name_en: string | null }[] = [];
    const toUpdate: { id: string; level_id: string; name_ar: string; name_en: string | null }[] = [];
    for (const s of structRows) {
      if (!levelIdByOrder.has(s.level)) continue;
      const levelId = levelIdByOrder.get(s.level)!;
      const existingId = positionIdByCode.get(s.code);
      if (existingId) {
        toUpdate.push({ id: existingId, level_id: levelId, name_ar: s.nameAr, name_en: s.nameEn });
      } else {
        toInsert.push({ external_code: s.code, level_id: levelId, name_ar: s.nameAr, name_en: s.nameEn });
      }
    }

    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const { data: inserted, error } = await supabase.from("org_structure_positions").insert(batch).select("id, external_code");
      if (error) {
        positionErrors.push(`positions insert batch ${i / BATCH_SIZE + 1}: ${error.message}`);
      } else {
        positionsUpserted += inserted?.length ?? 0;
        for (const p of inserted ?? []) positionIdByCode.set(p.external_code as string, p.id);
      }
    }

    for (const p of toUpdate) {
      const { error } = await supabase
        .from("org_structure_positions")
        .update({ level_id: p.level_id, name_ar: p.name_ar, name_en: p.name_en })
        .eq("id", p.id);
      if (error) {
        positionErrors.push(`position ${p.id}: ${error.message}`);
      } else {
        positionsUpserted += 1;
      }
    }

    for (const s of structRows) {
      if (!s.parentCode) continue;
      const positionId = positionIdByCode.get(s.code);
      const parentId = positionIdByCode.get(s.parentCode);
      if (!positionId) continue;
      if (!parentId) {
        positionErrors.push(`position ${s.code} ("${s.nameAr}"): parent code ${s.parentCode} not found — left without a parent`);
        continue;
      }
      const { error } = await supabase.from("org_structure_positions").update({ parent_id: parentId }).eq("id", positionId);
      if (error) positionErrors.push(`position ${s.code}: ${error.message}`);
    }

    // 8. org_structure_assignments — staffing embedded in the structure
    //    sheet. Only ever ADDS a missing assignment (matching the project
    //    owner's "اسمح بالإضافة والتعديل"); never removes an existing one on
    //    re-import, since the sheet has no way to express "unassign" and
    //    silently doing so on a re-run would be a real, surprising data loss.
    //    Can't use .upsert() here — the uniqueness is a PARTIAL index
    //    (WHERE deleted_at IS NULL), the same limitation already documented
    //    for evaluation_scores/calibration_results — so this checks first.
    const { data: profilesByNumber } = await supabase
      .from("profiles")
      .select("id, employee_number")
      .is("deleted_at", null);
    const profileIdByNumber = new Map((profilesByNumber ?? []).map((p) => [p.employee_number, p.id]));

    const { data: existingAssignments } = await supabase
      .from("org_structure_assignments")
      .select("position_id, employee_id")
      .is("deleted_at", null);
    const existingAssignmentKeys = new Set((existingAssignments ?? []).map((a) => `${a.position_id}::${a.employee_id}`));

    const newAssignments: { position_id: string; employee_id: string }[] = [];
    for (const s of structRows) {
      if (!s.employeeNumber) continue;
      const positionId = positionIdByCode.get(s.code);
      const employeeId = profileIdByNumber.get(s.employeeNumber);
      if (!positionId) continue;
      if (!employeeId) {
        assignmentErrors.push(`position ${s.code}: employee number ${s.employeeNumber} not found among imported employees`);
        continue;
      }
      const key = `${positionId}::${employeeId}`;
      if (existingAssignmentKeys.has(key)) continue;
      existingAssignmentKeys.add(key);
      newAssignments.push({ position_id: positionId, employee_id: employeeId });
    }

    if (newAssignments.length > 0) {
      const { error, count } = await supabase
        .from("org_structure_assignments")
        .insert(newAssignments, { count: "exact" });
      if (error) {
        assignmentErrors.push(`assignments: ${error.message}`);
      } else {
        assignmentsCreated = count ?? newAssignments.length;
      }
    }
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "org_structure_excel_imported",
    entity: "org_structure_positions",
    after_data: {
      mode: options.mode,
      employeesUpserted,
      rolesAssigned,
      levelsCreated,
      positionsUpserted,
      assignmentsCreated,
      employeeErrorCount: employeeErrors.length,
      roleErrorCount: roleErrors.length,
      positionErrorCount: positionErrors.length,
      assignmentErrorCount: assignmentErrors.length,
      supervisorsLinked: staff.supervisorsLinked,
      unknownSupervisorCount: staff.unknownSupervisors.length,
      approvedCreated: staff.approvedCreated,
      pendingCreated: staff.pendingCreated,
    },
  });

  return {
    status: "success",
    summary: {
      employeesUpserted,
      employeeErrors,
      rolesAssigned,
      roleErrors,
      levelsCreated,
      positionsUpserted,
      positionErrors,
      assignmentsCreated,
      assignmentErrors,
      unmatchedOrgUnits: [...unmatchedOrgUnitsSet],
      corrections,
      supervisorsLinked: staff.supervisorsLinked,
      unknownSupervisors: staff.unknownSupervisors,
      approvedCreated: staff.approvedCreated,
      pendingCreated: staff.pendingCreated,
      withoutEmail: staff.withoutEmail,
      dryRun: false,
    },
  };
}
