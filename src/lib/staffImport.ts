import type { SupabaseClient } from "@supabase/supabase-js";
import { updatesExisting, writesField, type ImportOptions } from "@/lib/excelImportOptions";
import { findSupervisorCycles, placeRows, type PlacementRow } from "@/lib/staffPlacement";

/**
 * The employee half of the Excel import, as a library
 * (docs/superpowers/specs/2026-10-15-staff-bulk-onboarding-design.md §4-ب).
 *
 * Extracted from `importOrgStructureExcel` on 2026-10-15 so it can be driven
 * by a signed-in `SupabaseClient` from an integration test, not only from the
 * Server Action. Every write still goes through the caller's RLS client; the
 * action keeps the audit row.
 *
 * What it adds over the old inline code: a supervisor pass (the
 * "الرقم الوظيفي للرئيس المباشر" column), an explicit approval status for NEW
 * rows (complete placement → approved, otherwise pending), the free-text title
 * kept as a hint instead of a new job title, roles derived from the reporting
 * tree, and a dry run that computes the same report without writing.
 */
export interface StaffImportRow {
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
  supervisorNumber: string | null;
}

export interface StaffImportSummary {
  employeesUpserted: number;
  employeeErrors: string[];
  rolesAssigned: number;
  roleErrors: string[];
  unmatchedOrgUnits: string[];
  supervisorsLinked: number;
  unknownSupervisors: string[];
  approvedCreated: number;
  pendingCreated: number;
  withoutEmail: number;
  dryRun: boolean;
}

const BATCH_SIZE = 50;

type ExistingProfile = { id: string; employee_number: string; auth_user_id: string | null; org_unit_id: string | null; email: string | null; job_title_id: string | null };
type RoleTarget = { profileId: string; authUserId: string | null; roleId: string; scope: "all" | "org_unit"; orgUnitId: string | null };

export async function importStaffRows(
  supabase: SupabaseClient,
  input: StaffImportRow[],
  options: ImportOptions,
  actorId: string,
  dryRun: boolean
): Promise<StaffImportSummary> {
  const employeeErrors: string[] = [];
  const roleErrors: string[] = [];
  const unknownSupervisors: string[] = [];
  const unmatched = new Set<string>();
  const summary = (partial: Partial<StaffImportSummary> = {}): StaffImportSummary => ({
    employeesUpserted: 0, employeeErrors, rolesAssigned: 0, roleErrors, unmatchedOrgUnits: [...unmatched],
    supervisorsLinked: 0, unknownSupervisors, approvedCreated: 0, pendingCreated: 0, withoutEmail: 0, dryRun, ...partial,
  });

  // Duplicate numbers inside the file: last row wins, reported.
  const byNumber = new Map<string, StaffImportRow>();
  for (const r of input) {
    if (byNumber.has(r.employeeNumber)) employeeErrors.push(`${r.employeeNumber}: duplicated in file — last row used`);
    byNumber.set(r.employeeNumber, r);
  }
  const rows = [...byNumber.values()];

  const cycles = findSupervisorCycles(rows.map((r) => ({ employeeNumber: r.employeeNumber, orgUnitId: null, supervisorNumber: r.supervisorNumber })));
  if (cycles.length > 0) {
    employeeErrors.push(`supervisor cycle: ${cycles.join(", ")} — nothing imported`);
    return summary();
  }

  // ---------------------------------------------------------------------
  // 1. Reference data — org units (exact match on trimmed name_ar only, per
  //    the project owner's "حاول المطابقة ونصلحها فيما بعد"), job families,
  //    and the profiles that already exist (by number, for new-vs-existing,
  //    email collisions and supervisors known only from the database).
  // ---------------------------------------------------------------------
  const { data: orgUnitsData } = await supabase.from("org_units").select("id, name_ar").is("deleted_at", null);
  const orgUnitByName = new Map((orgUnitsData ?? []).map((u) => [u.name_ar.trim(), u.id as string]));

  const { data: familiesData } = await supabase.from("job_families").select("id, name_ar");
  const academicFamilyId = familiesData?.find((f) => f.name_ar === "الأكاديمي")?.id ?? null;
  const generalFamilyId = familiesData?.find((f) => f.name_ar === "عام")?.id ?? null;

  const { data: existingData } = await supabase
    .from("profiles")
    .select("id, employee_number, auth_user_id, org_unit_id, email, job_title_id")
    .is("deleted_at", null);
  const existing = new Map<string, ExistingProfile>(((existingData ?? []) as ExistingProfile[]).map((p) => [p.employee_number, p]));
  const emailOwner = new Map<string, string>();
  for (const p of existing.values()) if (p.email) emailOwner.set(p.email.toLowerCase(), p.employee_number);

  // ---------------------------------------------------------------------
  // 2. Job titles — find-or-create by (job_family_id, name_ar) ONLY for rows
  //    that carry a grade (the 2026-07-20 salary-scale precedent); the merged
  //    HR file carries none, so nothing is created from its free text. A row's
  //    title resolves by family::name, else by a UNIQUE exact name_ar match;
  //    otherwise the text is kept as `job_title_hint` for the admin.
  // ---------------------------------------------------------------------
  const isAcademic = (r: StaffImportRow) => r.employeeCategory?.toLowerCase().startsWith("academic") ?? false;
  const familyOf = (r: StaffImportRow) => (isAcademic(r) ? academicFamilyId : generalFamilyId);
  const distinctTitles = new Map<string, { name_ar: string; name_en: string | null; grade_level: number; job_family_id: string; category: "academic" | "admin" }>();
  for (const r of rows) {
    if (!r.positionAr || r.gradeCode == null) continue;
    const familyId = familyOf(r);
    if (!familyId) continue;
    const key = `${familyId}::${r.positionAr}`;
    if (!distinctTitles.has(key)) {
      distinctTitles.set(key, { name_ar: r.positionAr, name_en: r.positionEn, grade_level: r.gradeCode, job_family_id: familyId, category: isAcademic(r) ? "academic" : "admin" });
    }
  }
  if (distinctTitles.size > 0 && !dryRun) {
    const { error } = await supabase.from("job_titles").upsert([...distinctTitles.values()], { onConflict: "job_family_id,name_ar", ignoreDuplicates: true });
    if (error) employeeErrors.push(`job_titles: ${error.message}`);
  }
  const { data: allTitles } = await supabase.from("job_titles").select("id, job_family_id, name_ar").is("deleted_at", null);
  const titleIdByKey = new Map((allTitles ?? []).map((t) => [`${t.job_family_id}::${t.name_ar}`, t.id as string]));
  const titleIdsByName = new Map<string, string[]>();
  for (const t of allTitles ?? []) {
    const name = (t.name_ar as string).trim();
    titleIdsByName.set(name, [...(titleIdsByName.get(name) ?? []), t.id as string]);
  }
  const resolveTitle = (r: StaffImportRow): string | null => {
    if (!r.positionAr) return null;
    const familyId = familyOf(r);
    const byFamily = familyId ? titleIdByKey.get(`${familyId}::${r.positionAr}`) : undefined;
    if (byFamily) return byFamily;
    const byName = titleIdsByName.get(r.positionAr.trim());
    return byName && byName.length === 1 ? byName[0] : null;
  };

  // ---------------------------------------------------------------------
  // 3. Email collisions are isolated BEFORE batching: one row whose email
  //    belongs to another employee number would otherwise fail its whole
  //    batch of 50 with 23505 (profiles.email is UNIQUE).
  // ---------------------------------------------------------------------
  const accepted = rows.filter((r) => {
    const owner = r.email ? emailOwner.get(r.email.toLowerCase()) : undefined;
    if (owner && owner !== r.employeeNumber) {
      employeeErrors.push(`${r.employeeNumber}: email already used by ${owner} — skipped`);
      return false;
    }
    return true;
  });

  // ---------------------------------------------------------------------
  // 4. Placement verdicts — the file's rows plus every number the database
  //    already knows, so a supervisor who is not in this file still resolves.
  // ---------------------------------------------------------------------
  const unitOf = (r: StaffImportRow): string | null => {
    if (!r.departmentAr) return null;
    const id = orgUnitByName.get(r.departmentAr.trim()) ?? null;
    if (!id) unmatched.add(r.departmentAr);
    return id;
  };
  const unitByNumber = new Map(accepted.map((r) => [r.employeeNumber, unitOf(r)]));
  const placement: PlacementRow[] = accepted.map((r) => ({ employeeNumber: r.employeeNumber, orgUnitId: unitByNumber.get(r.employeeNumber) ?? null, supervisorNumber: r.supervisorNumber }));
  const known = new Map<string, { orgUnitId: string | null }>();
  for (const [n, p] of existing) known.set(n, { orgUnitId: p.org_unit_id });
  for (const p of placement) known.set(p.employeeNumber, { orgUnitId: p.orgUnitId });
  const verdicts = placeRows(placement, known);

  const isNew = (r: StaffImportRow) => !existing.has(r.employeeNumber);
  const willWrite = (r: StaffImportRow) => isNew(r) || updatesExisting(options);
  for (const r of accepted) {
    if (!willWrite(r)) continue;
    const v = verdicts.get(r.employeeNumber)!;
    if (v.selfSupervision) employeeErrors.push(`${r.employeeNumber}: supervisor is self — left without supervisor`);
    else if (r.supervisorNumber && !v.supervisorResolved) unknownSupervisors.push(`${r.employeeNumber} → ${r.supervisorNumber}`);
  }
  const newRows = accepted.filter(isNew);
  const approvedCreated = newRows.filter((r) => verdicts.get(r.employeeNumber)!.approved).length;
  const pendingCreated = newRows.length - approvedCreated;
  const withoutEmail = accepted.filter((r) => willWrite(r) && !r.email).length;

  // ---------------------------------------------------------------------
  // 5. Role plan — derived from the reporting tree (spec §4-ب item 5) plus
  //    the legacy "الدور في النظام" column. Counted the same way in both the
  //    dry run and the real run; written in step 8 after the profiles exist.
  // ---------------------------------------------------------------------
  const { data: rolesData } = await supabase.from("roles").select("id, role_code, name_ar");
  const roleIdByCode = new Map((rolesData ?? []).map((r) => [r.role_code as string, r.id as string]));
  const roleIdByName = new Map((rolesData ?? []).map((r) => [(r.name_ar as string).trim(), r.id as string]));
  const plan = new Map<string, Array<{ roleId: string; scope: "all" | "org_unit"; orgUnitId: string | null }>>();
  const wanted = (code: string) => {
    const id = roleIdByCode.get(code);
    if (!id) roleErrors.push(`role "${code}" is not seeded — skipped`);
    return id ?? null;
  };
  const employeeRoleId = wanted("employee");
  const supervisorRoleId = wanted("supervisor");
  const managerRoleId = wanted("manager");
  for (const r of accepted) {
    if (!willWrite(r)) continue;
    const v = verdicts.get(r.employeeNumber)!;
    const list: Array<{ roleId: string; scope: "all" | "org_unit"; orgUnitId: string | null }> = [];
    if (employeeRoleId) list.push({ roleId: employeeRoleId, scope: "all", orgUnitId: null });
    if (v.isSupervisor && supervisorRoleId) list.push({ roleId: supervisorRoleId, scope: "all", orgUnitId: null });
    if (v.headOfOrgUnitId && managerRoleId) list.push({ roleId: managerRoleId, scope: "org_unit", orgUnitId: v.headOfOrgUnitId });
    if (r.roleName) {
      const legacy = roleIdByName.get(r.roleName.trim());
      if (legacy) list.push({ roleId: legacy, scope: "all", orgUnitId: null });
      else roleErrors.push(`${r.employeeNumber}: role "${r.roleName}" not found — skipped`);
    }
    plan.set(r.employeeNumber, list);
  }
  const plannedRoleCount = [...plan.values()].reduce((n, l) => n + l.length, 0);

  if (dryRun) {
    return summary({ approvedCreated, pendingCreated, withoutEmail, rolesAssigned: plannedRoleCount });
  }

  // ---------------------------------------------------------------------
  // 6. Profiles — new rows are INSERTed with their verdict's approval status
  //    and created_by; existing rows are UPSERTed (only in upsert mode) with
  //    neither, so a status set by hand is never rewritten by a re-run. A
  //    chosen job title on an existing row is never replaced by the file.
  // ---------------------------------------------------------------------
  const buildRow = (r: StaffImportRow, forNew: boolean): Record<string, unknown> => {
    const row: Record<string, unknown> = { employee_number: r.employeeNumber, full_name_ar: r.fullNameAr };
    const orgUnitId = unitByNumber.get(r.employeeNumber) ?? null;
    const titleId = resolveTitle(r);
    const existingTitle = existing.get(r.employeeNumber)?.job_title_id ?? null;
    const optional: Array<[string, string, unknown]> = [
      ["fullNameEn", "full_name_en", r.fullNameEn],
      ["email", "email", r.email],
      ["department", "org_unit_id", orgUnitId],
      ["hireDate", "hire_date", r.hireDate],
      ["qualification", "qualification", r.qualification],
      ["educationSpeciality", "education_speciality", r.educationSpeciality],
      ["dateOfBirth", "date_of_birth", r.dateOfBirth],
      ["mobile", "mobile", r.mobile],
      ["maritalStatus", "marital_status", r.maritalStatus],
      ["gender", "gender", r.gender],
      ["nationality", "nationality", r.nationality],
      ["employeeCategory", "employee_category", r.employeeCategory],
      ["insuranceCategory", "insurance_category", r.insuranceCategory],
    ];
    for (const [field, column, value] of optional) if (writesField(options, field)) row[column] = value;
    if (writesField(options, "positionAr")) {
      if (titleId && (forNew || !existingTitle)) row.job_title_id = titleId;
      if (r.positionAr && !titleId) row.job_title_hint = r.positionAr;
    }
    if (forNew) {
      row.approval_status = verdicts.get(r.employeeNumber)!.approved ? "approved" : "pending";
      row.created_by = actorId;
    }
    return row;
  };

  let employeesUpserted = 0;
  const inserts = newRows.map((r) => buildRow(r, true));
  for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
    const batch = inserts.slice(i, i + BATCH_SIZE);
    const { error, count } = await supabase.from("profiles").insert(batch, { count: "exact" });
    if (error) employeeErrors.push(`insert batch ${i / BATCH_SIZE + 1}: ${error.message}`);
    else employeesUpserted += count ?? batch.length;
  }
  if (updatesExisting(options)) {
    const updates = accepted.filter((r) => !isNew(r)).map((r) => buildRow(r, false));
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      const { error, count } = await supabase.from("profiles").upsert(batch, { onConflict: "employee_number", count: "exact" });
      if (error) employeeErrors.push(`update batch ${i / BATCH_SIZE + 1}: ${error.message}`);
      else employeesUpserted += count ?? batch.length;
    }
  }

  // ---------------------------------------------------------------------
  // 7. Supervisor pass — every number is now a row (or was already). One
  //    UPDATE per supervisor, limited to the rows this run wrote; a self or
  //    unresolved supervisor was reported above and is simply not linked.
  // ---------------------------------------------------------------------
  const numbersNeeded = new Set<string>();
  for (const r of accepted) {
    numbersNeeded.add(r.employeeNumber);
    if (r.supervisorNumber) numbersNeeded.add(r.supervisorNumber);
  }
  const { data: afterWrite } = await supabase
    .from("profiles")
    .select("id, employee_number, auth_user_id")
    .is("deleted_at", null)
    .in("employee_number", [...numbersNeeded]);
  const profileByNumber = new Map(((afterWrite ?? []) as { id: string; employee_number: string; auth_user_id: string | null }[]).map((p) => [p.employee_number, p]));

  let supervisorsLinked = 0;
  const bySupervisor = new Map<string, string[]>();
  for (const r of accepted) {
    if (!willWrite(r) || !r.supervisorNumber) continue;
    const v = verdicts.get(r.employeeNumber)!;
    if (v.selfSupervision || !v.supervisorResolved) continue;
    if (!profileByNumber.has(r.employeeNumber)) continue; // its insert failed; already reported
    const sup = profileByNumber.get(r.supervisorNumber);
    if (!sup) { unknownSupervisors.push(`${r.employeeNumber} → ${r.supervisorNumber}`); continue; }
    bySupervisor.set(sup.id, [...(bySupervisor.get(sup.id) ?? []), r.employeeNumber]);
  }
  for (const [supervisorId, numbers] of bySupervisor) {
    const { error, count } = await supabase.from("profiles").update({ supervisor_id: supervisorId }, { count: "exact" }).in("employee_number", numbers);
    if (error) employeeErrors.push(`supervisor ${supervisorId}: ${error.message}`);
    else supervisorsLinked += count ?? numbers.length;
  }

  // ---------------------------------------------------------------------
  // 8. Roles — a linked account writes to user_roles (keyed by auth user), an
  //    unlinked one to pending_role_assignments (promoted by
  //    link_profile_to_auth_user() on first login). Both tables' uniqueness
  //    is a PARTIAL index, so existing rows are selected first and only the
  //    missing ones inserted; nothing is ever removed.
  // ---------------------------------------------------------------------
  const targets: RoleTarget[] = [];
  for (const [number, list] of plan) {
    const p = profileByNumber.get(number);
    if (!p) continue;
    for (const item of list) targets.push({ profileId: p.id, authUserId: p.auth_user_id, roleId: item.roleId, scope: item.scope, orgUnitId: item.orgUnitId });
  }
  const linkedUserIds = [...new Set(targets.filter((t) => t.authUserId).map((t) => t.authUserId as string))];
  const unlinkedProfileIds = [...new Set(targets.filter((t) => !t.authUserId).map((t) => t.profileId))];
  const [{ data: existingUserRoles }, { data: existingPending }] = await Promise.all([
    linkedUserIds.length > 0
      ? supabase.from("user_roles").select("user_id, role_id, scope_type, org_unit_id").in("user_id", linkedUserIds)
      : Promise.resolve({ data: [] as { user_id: string; role_id: string; scope_type: string; org_unit_id: string | null }[] }),
    unlinkedProfileIds.length > 0
      ? supabase.from("pending_role_assignments").select("profile_id, role_id, scope_type, org_unit_id").in("profile_id", unlinkedProfileIds)
      : Promise.resolve({ data: [] as { profile_id: string; role_id: string; scope_type: string; org_unit_id: string | null }[] }),
  ]);
  const key = (owner: string, roleId: string, scope: string, orgUnitId: string | null) => `${owner}::${roleId}::${scope}::${orgUnitId ?? ""}`;
  const have = new Set<string>([
    ...(existingUserRoles ?? []).map((r) => key(r.user_id, r.role_id, r.scope_type, r.org_unit_id)),
    ...(existingPending ?? []).map((r) => key(r.profile_id, r.role_id, r.scope_type, r.org_unit_id)),
  ]);
  const newUserRoles: Record<string, unknown>[] = [];
  const newPending: Record<string, unknown>[] = [];
  for (const t of targets) {
    const owner = t.authUserId ?? t.profileId;
    const k = key(owner, t.roleId, t.scope, t.orgUnitId);
    if (have.has(k)) continue;
    have.add(k);
    if (t.authUserId) newUserRoles.push({ user_id: t.authUserId, role_id: t.roleId, scope_type: t.scope, org_unit_id: t.orgUnitId, assigned_by: actorId });
    else newPending.push({ profile_id: t.profileId, role_id: t.roleId, scope_type: t.scope, org_unit_id: t.orgUnitId, assigned_by: actorId });
  }
  let rolesAssigned = 0;
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

  return summary({ employeesUpserted, rolesAssigned, supervisorsLinked, approvedCreated, pendingCreated, withoutEmail });
}
