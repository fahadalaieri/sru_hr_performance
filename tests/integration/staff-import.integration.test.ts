import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient, env, Fixtures, hasDatabase, type TempUser } from "./helpers";
import { importStaffRows, type StaffImportRow } from "../../src/lib/staffImport";
import type { ImportOptions } from "../../src/lib/excelImportOptions";

/**
 * Bulk staff import (spec 2026-10-15): placement verdicts, supervisor pass,
 * derived roles and the dry run — through a real super_admin session so every
 * write is checked by RLS exactly as the Server Action would be.
 */
describe.skipIf(!hasDatabase)("importStaffRows", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  const tag = fx.tag;
  let actor: TempUser;
  let session: SupabaseClient;
  let unitA: string;
  let unitB: string;
  const no = (k: string) => `TMPIT-BULK-${k}-${tag}`;
  const row = (k: string, over: Partial<StaffImportRow> = {}): StaffImportRow => ({
    employeeNumber: no(k), fullNameAr: `موظف ${k}`, fullNameEn: null, email: `tmp-it-bulk-${k}-${tag}@sru-dev.internal`,
    hireDate: null, qualification: null, educationSpeciality: null, dateOfBirth: null, mobile: null, maritalStatus: null,
    gender: null, nationality: null, departmentAr: null, positionAr: null, positionEn: null, gradeCode: null,
    employeeCategory: null, insuranceCategory: null, roleName: null, supervisorNumber: null, ...over,
  });
  const options: ImportOptions = { mode: "insert_only", fields: null, mapping: new Map(), ignored: new Set() };

  beforeAll(async () => {
    actor = await fx.user("bulkadmin");
    await admin.from("user_roles").insert({ user_id: actor.authUserId, role_id: await fx.roleId("super_admin"), scope_type: "all" });
    session = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await session.auth.signInWithPassword({ email: actor.email, password: actor.password });
    if (error) throw error;
    const { data: units } = await admin.from("org_units").select("name_ar").is("deleted_at", null).order("name_ar").limit(2);
    unitA = units![0].name_ar;
    unitB = units![1].name_ar;
  });

  afterAll(async () => {
    const { data } = await admin.from("profiles").select("id").like("employee_number", `TMPIT-BULK-%-${tag}`);
    if (data?.length) await admin.from("profiles").delete().in("id", data.map((p) => p.id)); // pending_role_assignments cascade
    await fx.cleanup();
  });

  const rows = (): StaffImportRow[] => [
    row("root", { departmentAr: unitA }), // president: root, supervises the dean
    row("dean", { departmentAr: unitB, supervisorNumber: no("root") }), // head of unitB
    row("emp", { departmentAr: unitB, supervisorNumber: no("dean"), positionAr: "مسمّى غير موجود" }),
    row("nounit", { departmentAr: "إدارة غير موجودة", supervisorNumber: no("dean") }),
    row("nosup", { departmentAr: unitB, supervisorNumber: no("ghost") }),
    row("noemail", { email: null, departmentAr: unitB, supervisorNumber: no("dean") }),
  ];
  const ids = async () => {
    const { data } = await admin.from("profiles").select("id, employee_number, approval_status, supervisor_id, org_unit_id, job_title_hint, job_title_id, created_by, email, auth_user_id").like("employee_number", `TMPIT-BULK-%-${tag}`);
    return new Map(data!.map((p) => [p.employee_number, p]));
  };

  it("dry run reports the plan and writes nothing", async () => {
    const s = await importStaffRows(session, rows(), options, actor.authUserId, true);
    expect(s).toMatchObject({ dryRun: true, approvedCreated: 4, pendingCreated: 2, withoutEmail: 1, unmatchedOrgUnits: ["إدارة غير موجودة"], employeesUpserted: 0, supervisorsLinked: 0 });
    expect(s.unknownSupervisors).toEqual([`${no("nosup")} → ${no("ghost")}`]);
    expect(s.rolesAssigned).toBe(6 + 2 + 2); // employee ×6, supervisor ×2 (root, dean), manager ×2
    expect((await ids()).size).toBe(0);
  });

  it("real run: statuses, supervisors, hint and roles", async () => {
    const s = await importStaffRows(session, rows(), options, actor.authUserId, false);
    expect(s).toMatchObject({ dryRun: false, employeesUpserted: 6, approvedCreated: 4, pendingCreated: 2, supervisorsLinked: 4, rolesAssigned: 10 });
    const by = await ids();
    expect(by.get(no("root"))!.approval_status).toBe("approved"); // Review Focus 5
    expect(by.get(no("dean"))!.approval_status).toBe("approved");
    expect(by.get(no("emp"))!.approval_status).toBe("approved");
    expect(by.get(no("nounit"))!.approval_status).toBe("pending");
    expect(by.get(no("nosup"))!.approval_status).toBe("pending"); // Review Focus 2
    expect(by.get(no("noemail"))!.email).toBeNull();
    expect(by.get(no("noemail"))!.approval_status).toBe("approved");
    expect(by.get(no("emp"))!.job_title_hint).toBe("مسمّى غير موجود");
    expect(by.get(no("emp"))!.job_title_id).toBeNull();
    expect(by.get(no("emp"))!.created_by).toBe(actor.authUserId);
    expect(by.get(no("emp"))!.supervisor_id).toBe(by.get(no("dean"))!.id);
    expect(by.get(no("dean"))!.supervisor_id).toBe(by.get(no("root"))!.id);
    expect(by.get(no("nosup"))!.supervisor_id).toBeNull();
    // roles: unlinked profiles → pending_role_assignments
    const { data: pr } = await admin.from("pending_role_assignments").select("profile_id, scope_type, org_unit_id, roles(role_code)").in("profile_id", [...by.values()].map((p) => p.id));
    const codes = (k: string) => pr!.filter((r) => r.profile_id === by.get(no(k))!.id).map((r) => `${(r.roles as unknown as { role_code: string }).role_code}:${r.scope_type}`).sort();
    expect(codes("emp")).toEqual(["employee:all"]);
    expect(codes("dean")).toEqual(["employee:all", "manager:org_unit", "supervisor:all"]);
    expect(pr!.find((r) => r.profile_id === by.get(no("dean"))!.id && r.scope_type === "org_unit")!.org_unit_id).toBe(by.get(no("dean"))!.org_unit_id);
    expect(codes("root")).toEqual(["employee:all", "manager:org_unit", "supervisor:all"]);
    expect(codes("nounit")).toEqual(["employee:all"]);
  });

  it("insert_only re-run leaves existing rows alone; upsert updates placement but never the status", async () => {
    // Review Focus 3
    await admin.from("profiles").update({ approval_status: "approved" }).eq("employee_number", no("nosup"));
    const again = rows().map((r) => (r.employeeNumber === no("nosup") ? { ...r, supervisorNumber: no("dean") } : r));
    const s1 = await importStaffRows(session, again, options, actor.authUserId, false);
    expect(s1.employeesUpserted).toBe(0);
    expect(s1.rolesAssigned).toBe(0);
    expect((await ids()).get(no("nosup"))!.supervisor_id).toBeNull();

    const s2 = await importStaffRows(session, again, { ...options, mode: "upsert" }, actor.authUserId, false);
    expect(s2.employeesUpserted).toBe(6);
    const by = await ids();
    expect(by.get(no("nosup"))!.supervisor_id).toBe(by.get(no("dean"))!.id);
    expect(by.get(no("nosup"))!.approval_status).toBe("approved"); // set by hand above, untouched
    expect(by.get(no("nounit"))!.approval_status).toBe("pending"); // existing status untouched by upsert
    expect(by.get(no("emp"))!.created_by).toBe(actor.authUserId);
  });

  it("email collision is isolated to its row", async () => {
    // Review Focus 1
    const clash = row("clash", { email: `tmp-it-bulk-emp-${tag}@sru-dev.internal`, departmentAr: unitB, supervisorNumber: no("dean") });
    const ok = row("ok", { departmentAr: unitB, supervisorNumber: no("dean") });
    const s = await importStaffRows(session, [clash, ok], options, actor.authUserId, false);
    expect(s.employeesUpserted).toBe(1);
    expect(s.employeeErrors.some((e) => e.startsWith(no("clash")))).toBe(true);
    expect((await ids()).get(no("ok"))!.supervisor_id).not.toBeNull(); // supervisor known from the database, not the file
  });

  it("self-supervision is reported, never written", async () => {
    // Review Focus 4
    const s = await importStaffRows(session, [row("selfie", { departmentAr: unitB, supervisorNumber: no("selfie") })], options, actor.authUserId, false);
    expect(s.pendingCreated).toBe(1);
    expect(s.employeeErrors.some((e) => e.includes("self"))).toBe(true);
    expect((await ids()).get(no("selfie"))!.supervisor_id).toBeNull();
  });

  it("a supervisor cycle aborts the whole import before any write", async () => {
    const s = await importStaffRows(session, [row("c1", { supervisorNumber: no("c2") }), row("c2", { supervisorNumber: no("c1") })], options, actor.authUserId, false);
    expect(s.employeesUpserted).toBe(0);
    expect(s.employeeErrors[0]).toMatch(/cycle/);
    expect((await ids()).has(no("c1"))).toBe(false);
  });
});
