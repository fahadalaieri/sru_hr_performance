import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient, env, Fixtures, hasDatabase, type TempUser } from "./helpers";
import { generateCycleEvaluations } from "../../src/lib/cycleEvaluations";

/**
 * Phase 2 item 5: launching a cycle creates one draft supervisor evaluation
 * per eligible employee, through a real approver session (RLS), idempotently,
 * and reports who is not ready and why.
 */
describe.skipIf(!hasDatabase)("generateCycleEvaluations", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  let hr: TempUser;
  let session: SupabaseClient;
  let cycleId: string;
  let unitId: string;
  let sup: TempUser, ok1: TempUser, ok2: TempUser, noSup: TempUser, onLeave: TempUser, lateHire: TempUser;

  beforeAll(async () => {
    unitId = (await admin.from("org_units").select("id").is("deleted_at", null).order("name_ar").limit(1).single()).data!.id;
    hr = await fx.user("launchhr", { org_unit_id: unitId });
    await admin.from("user_roles").insert({ user_id: hr.authUserId, role_id: await fx.roleId("hr_admin"), scope_type: "all" });
    session = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await session.auth.signInWithPassword({ email: hr.email, password: hr.password });
    if (error) throw error;
    sup = await fx.user("lsup", { org_unit_id: unitId });
    ok1 = await fx.user("lok1", { org_unit_id: unitId, supervisor_id: sup.profileId });
    ok2 = await fx.user("lok2", { org_unit_id: unitId, supervisor_id: sup.profileId, hire_date: "2020-01-15" });
    noSup = await fx.user("lnosup", { org_unit_id: unitId });
    onLeave = await fx.user("lleave", { org_unit_id: unitId, supervisor_id: sup.profileId, status: "on_leave" });
    lateHire = await fx.user("llate", { org_unit_id: unitId, supervisor_id: sup.profileId, hire_date: "2026-09-01" });
    cycleId = (await admin.from("evaluation_cycles").insert({ name_ar: `دورة إطلاق ${fx.tag}`, start_date: "2026-01-01", end_date: "2026-12-31", cycle_type: "calendar" }).select("id").single()).data!.id;
  });

  afterAll(async () => {
    await admin.from("evaluations").delete().eq("cycle_id", cycleId);
    await admin.from("evaluation_cycles").delete().eq("id", cycleId);
    await fx.cleanup();
  });

  const mine = (s: { notReady: Array<{ employeeNumber: string; reasons: string[] }> }) => s.notReady.filter((n) => n.employeeNumber.includes(fx.tag));

  it("dry run plans without writing", async () => {
    const out = (await generateCycleEvaluations(session, cycleId, true))!;
    expect(out.dryRun).toBe(true);
    expect(out.created).toBe(0);
    const notReady = mine(out.summary);
    expect(notReady.map((n) => [n.employeeNumber.split("-")[1], n.reasons])).toEqual(
      expect.arrayContaining([
        ["lnosup", ["no_supervisor"]],
        ["lleave", ["not_active"]],
        ["llate", ["hired_too_late"]],
        ["lsup", ["no_supervisor"]],
      ])
    );
    const { count } = await admin.from("evaluations").select("id", { count: "exact", head: true }).eq("cycle_id", cycleId);
    expect(count).toBe(0);
  });

  it("the real run creates exactly the eligible ones as draft supervisor evaluations, and a second run creates none", async () => {
    const out = (await generateCycleEvaluations(session, cycleId, false))!;
    expect(out.errors).toEqual([]);
    const { data } = await admin.from("evaluations").select("employee_id, state, eval_type").eq("cycle_id", cycleId);
    const ids = new Set(data!.map((e) => e.employee_id));
    expect(ids.has(ok1.profileId)).toBe(true);
    expect(ids.has(ok2.profileId)).toBe(true);
    expect(ids.has(noSup.profileId)).toBe(false);
    expect(ids.has(onLeave.profileId)).toBe(false);
    expect(ids.has(lateHire.profileId)).toBe(false);
    expect(data!.every((e) => e.state === "draft" && e.eval_type === "supervisor")).toBe(true);
    expect(out.created).toBeGreaterThanOrEqual(2);
    const again = (await generateCycleEvaluations(session, cycleId, false))!;
    expect(again.created).toBe(0);
    expect(again.summary.toCreate).toBe(0);
  });
});
