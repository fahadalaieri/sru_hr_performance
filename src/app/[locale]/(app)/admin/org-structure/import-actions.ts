"use server";

import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ORG_STRUCTURE_IMPORT_COLUMNS } from "@/lib/importColumns";
import { applyMapping, parseImportOptions, updatesExisting, writesField } from "@/lib/excelImportOptions";
import { cellText, headerMap, loadImportWorkbook } from "@/lib/excelImport";

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

  const employeeErrors: string[] = [];
  const roleErrors: string[] = [];
  const positionErrors: string[] = [];
  const assignmentErrors: string[] = [];
  const corrections: string[] = [];
  const unmatchedOrgUnitsSet = new Set<string>();

  // ---------------------------------------------------------------------
  // 1. Org units — fetch once for department-name matching (exact match on
  //    trimmed name_ar only, per the project owner's "حاول المطابقة
  //    ونصلحها فيما بعد" — best-effort now, manual correction later, not a
  //    fuzzy/approximate matcher that could silently mismatch).
  // ---------------------------------------------------------------------
  const { data: orgUnitsData } = await supabase.from("org_units").select("id, name_ar").is("deleted_at", null);
  const orgUnitByName = new Map((orgUnitsData ?? []).map((u) => [u.name_ar.trim(), u.id]));

  // ---------------------------------------------------------------------
  // 2. job_families — reuse the existing placeholder families rather than
  //    inventing new ones (established precedent from the 2026-07-20
  //    job_titles data import): "Academic" -> "الأكاديمي", everything else
  //    -> "عام".
  // ---------------------------------------------------------------------
  const { data: familiesData } = await supabase.from("job_families").select("id, name_ar");
  const academicFamilyId = familiesData?.find((f) => f.name_ar === "الأكاديمي")?.id ?? null;
  const generalFamilyId = familiesData?.find((f) => f.name_ar === "عام")?.id ?? null;

  // ---------------------------------------------------------------------
  // 3. Parse "Employees Data" rows.
  // ---------------------------------------------------------------------
  interface EmployeeRow {
    employeeNumber: string;
    fullNameAr: string;
    fullNameEn: string | null;
    email: string | null;
    hireDate: string | null;
    qualification: string | null;
    educationSpeciality: string | null;
    dateOfBirth: string | null;
    mobile: string | null;
    maritalStatus: string | null;
    gender: string | null;
    nationality: string | null;
    departmentAr: string | null;
    positionAr: string | null;
    positionEn: string | null;
    gradeCode: number | null;
    employeeCategory: string | null;
    insuranceCategory: string | null;
    roleName: string | null;
  }

  const employeeRows: EmployeeRow[] = [];

  if (employeesSheet && empCols) {
    const cols = empCols;
    const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);

    for (let r = 2; r <= employeesSheet.rowCount; r++) {
      const row = employeesSheet.getRow(r);
      const employeeNumber = cellText(get(row, "EMPLOYEE NUMBER"));
      if (!employeeNumber) continue;

      const fullNameAr = cellText(get(row, "اسم الموظف"));
      const email = cellText(get(row, "EMAIL ID"))?.toLowerCase() ?? null;
      if (!fullNameAr || !email) {
        employeeErrors.push(`${employeeNumber}: missing required name or email — skipped`);
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
      });
    }
  }

  // -----------------------------------------------------------------------
  // 4. job_titles — find-or-create by (job_family_id, name_ar), the table's
  //    own unique constraint. `ignoreDuplicates: true` means an existing
  //    row's grade_level is never silently overwritten by a differently
  //    graded row that happens to share the same title text.
  // -----------------------------------------------------------------------
  const distinctTitles = new Map<string, { name_ar: string; name_en: string | null; grade_level: number; job_family_id: string; category: "academic" | "admin" }>();
  for (const emp of employeeRows) {
    if (!emp.positionAr || emp.gradeCode == null) continue;
    const isAcademic = emp.employeeCategory?.toLowerCase().startsWith("academic") ?? false;
    const familyId = isAcademic ? academicFamilyId : generalFamilyId;
    if (!familyId) continue;
    const key = `${familyId}::${emp.positionAr}`;
    if (!distinctTitles.has(key)) {
      distinctTitles.set(key, {
        name_ar: emp.positionAr,
        name_en: emp.positionEn,
        grade_level: emp.gradeCode,
        job_family_id: familyId,
        category: isAcademic ? "academic" : "admin",
      });
    }
  }

  if (distinctTitles.size > 0) {
    const { error: titlesError } = await supabase
      .from("job_titles")
      .upsert([...distinctTitles.values()], { onConflict: "job_family_id,name_ar", ignoreDuplicates: true });
    if (titlesError) {
      positionErrors.push(`job_titles: ${titlesError.message}`);
    }
  }

  const { data: allTitles } = await supabase.from("job_titles").select("id, job_family_id, name_ar").is("deleted_at", null);
  const titleIdByKey = new Map((allTitles ?? []).map((t) => [`${t.job_family_id}::${t.name_ar}`, t.id]));

  // -----------------------------------------------------------------------
  // 5. Upsert profiles by employee_number — never sends an auth invite;
  //    this is bulk historical data entry, not onboarding. auth_user_id
  //    stays NULL (inviting each real person is a separate, deliberate
  //    action, same as the existing single-employee "Add Employee" flow).
  // -----------------------------------------------------------------------
  const profileRows = employeeRows.map((emp) => {
    const orgUnitId = emp.departmentAr ? orgUnitByName.get(emp.departmentAr) ?? null : null;
    if (emp.departmentAr && !orgUnitId) unmatchedOrgUnitsSet.add(emp.departmentAr);

    const isAcademic = emp.employeeCategory?.toLowerCase().startsWith("academic") ?? false;
    const familyId = isAcademic ? academicFamilyId : generalFamilyId;
    const titleKey = emp.positionAr && familyId ? `${familyId}::${emp.positionAr}` : null;
    const jobTitleId = titleKey ? titleIdByKey.get(titleKey) ?? null : null;

    // The employee number identifies the row and is always written; every
    // other column is written only if the caller ticked it, so an unticked
    // field is left alone instead of being blanked from a column they did not
    // intend to import.
    const row: Record<string, unknown> = {
      employee_number: emp.employeeNumber,
      full_name_ar: emp.fullNameAr,
    };
    const optional: Array<[string, string, unknown]> = [
      ["fullNameEn", "full_name_en", emp.fullNameEn],
      ["email", "email", emp.email],
      ["department", "org_unit_id", orgUnitId],
      ["positionAr", "job_title_id", jobTitleId],
      ["hireDate", "hire_date", emp.hireDate],
      ["qualification", "qualification", emp.qualification],
      ["educationSpeciality", "education_speciality", emp.educationSpeciality],
      ["dateOfBirth", "date_of_birth", emp.dateOfBirth],
      ["mobile", "mobile", emp.mobile],
      ["maritalStatus", "marital_status", emp.maritalStatus],
      ["gender", "gender", emp.gender],
      ["nationality", "nationality", emp.nationality],
      ["employeeCategory", "employee_category", emp.employeeCategory],
      ["insuranceCategory", "insurance_category", emp.insuranceCategory],
    ];
    for (const [field, column, value] of optional) {
      if (writesField(options, field)) row[column] = value;
    }
    return row;
  });

  let employeesUpserted = 0;
  const BATCH_SIZE = 50;
  for (let i = 0; i < profileRows.length; i += BATCH_SIZE) {
    const batch = profileRows.slice(i, i + BATCH_SIZE);
    const { error, count } = await supabase.from("profiles").upsert(batch, {
      onConflict: "employee_number",
      // "Add new only" skips an employee who already has a record rather than
      // rewriting it — the difference between the two modes, in one flag.
      ignoreDuplicates: !updatesExisting(options),
      count: "exact",
    });
    if (error) {
      employeeErrors.push(`batch ${i / BATCH_SIZE + 1}: ${error.message}`);
    } else {
      employeesUpserted += count ?? batch.length;
    }
  }

  // -----------------------------------------------------------------------
  // 5b. Role assignment — the "الدور في النظام" column, read against real
  //     employee names (2026-07-24 follow-up). Matched by `roles.name_ar`
  //     (not role_code), since the template lists role names in Arabic like
  //     everything else in this app. A linked account (auth_user_id set)
  //     writes to `user_roles`; an invited-but-not-linked one writes to
  //     `pending_role_assignments` (promoted automatically once they accept
  //     their invite — see 20260721000001), same split the Employees list's
  //     own role column already reads from. Always scope_type='all' — a
  //     bulk sheet has no reasonable way to express an org-unit scope per
  //     row. Both tables' uniqueness is a PARTIAL index
  //     (`WHERE scope_type='all'`), the same limitation already hit for
  //     org_structure_positions/evaluation_scores/calibration_results, so
  //     this checks existing rows first rather than a blind upsert.
  // -----------------------------------------------------------------------
  const roleRowsToAssign = employeeRows.filter((e) => e.roleName);
  let rolesAssigned = 0;
  if (roleRowsToAssign.length > 0) {
    const { data: rolesData } = await supabase.from("roles").select("id, name_ar");
    const roleIdByName = new Map((rolesData ?? []).map((r) => [r.name_ar.trim(), r.id]));

    const { data: profilesForRoles } = await supabase
      .from("profiles")
      .select("id, employee_number, auth_user_id")
      .in(
        "employee_number",
        roleRowsToAssign.map((e) => e.employeeNumber)
      );
    const profileByNumber = new Map((profilesForRoles ?? []).map((p) => [p.employee_number, p]));

    const linkedUserIds = (profilesForRoles ?? []).filter((p) => p.auth_user_id).map((p) => p.auth_user_id as string);
    const unlinkedProfileIds = (profilesForRoles ?? []).filter((p) => !p.auth_user_id).map((p) => p.id);

    const [{ data: existingUserRoles }, { data: existingPending }] = await Promise.all([
      linkedUserIds.length > 0
        ? supabase.from("user_roles").select("user_id, role_id").eq("scope_type", "all").in("user_id", linkedUserIds)
        : Promise.resolve({ data: [] as { user_id: string; role_id: string }[] }),
      unlinkedProfileIds.length > 0
        ? supabase
            .from("pending_role_assignments")
            .select("profile_id, role_id")
            .eq("scope_type", "all")
            .in("profile_id", unlinkedProfileIds)
        : Promise.resolve({ data: [] as { profile_id: string; role_id: string }[] }),
    ]);
    const existingUserRoleKeys = new Set((existingUserRoles ?? []).map((r) => `${r.user_id}::${r.role_id}`));
    const existingPendingKeys = new Set((existingPending ?? []).map((r) => `${r.profile_id}::${r.role_id}`));

    const newUserRoles: { user_id: string; role_id: string; scope_type: "all" }[] = [];
    const newPending: { profile_id: string; role_id: string; scope_type: "all" }[] = [];

    for (const emp of roleRowsToAssign) {
      const roleId = roleIdByName.get(emp.roleName!.trim());
      if (!roleId) {
        roleErrors.push(`${emp.employeeNumber}: role "${emp.roleName}" not found — skipped`);
        continue;
      }
      const profile = profileByNumber.get(emp.employeeNumber);
      if (!profile) {
        roleErrors.push(`${emp.employeeNumber}: profile not found after upsert — skipped`);
        continue;
      }
      if (profile.auth_user_id) {
        const key = `${profile.auth_user_id}::${roleId}`;
        if (existingUserRoleKeys.has(key)) continue;
        existingUserRoleKeys.add(key);
        newUserRoles.push({ user_id: profile.auth_user_id, role_id: roleId, scope_type: "all" });
      } else {
        const key = `${profile.id}::${roleId}`;
        if (existingPendingKeys.has(key)) continue;
        existingPendingKeys.add(key);
        newPending.push({ profile_id: profile.id, role_id: roleId, scope_type: "all" });
      }
    }

    if (newUserRoles.length > 0) {
      const { error, count } = await supabase.from("user_roles").insert(newUserRoles, { count: "exact" });
      if (error) roleErrors.push(`user_roles: ${error.message}`);
      else rolesAssigned += count ?? newUserRoles.length;
    }
    if (newPending.length > 0) {
      const { error, count } = await supabase.from("pending_role_assignments").insert(newPending, { count: "exact" });
      if (error) roleErrors.push(`pending_role_assignments: ${error.message}`);
      else rolesAssigned += count ?? newPending.length;
    }
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
    },
  };
}
