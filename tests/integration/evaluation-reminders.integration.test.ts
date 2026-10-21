import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, Fixtures, hasDatabase, type TempUser } from "./helpers";
import { runEvaluationReminders } from "../../src/lib/evaluationReminders";

/**
 * Phase 2 item 7: who must act at each state (evaluation_actor_profile_ids)
 * and the daily reminder run (week / day / overdue, never twice).
 */
describe.skipIf(!hasDatabase)("evaluation actors and reminders", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  let unitId: string;
  let employee: TempUser, supervisor: TempUser, manager: TempUser, committee: TempUser, hr: TempUser;
  let cycleId: string;
  let evaluationId: string;

  beforeAll(async () => {
    unitId = (await admin.from("org_units").select("id").is("deleted_at", null).order("name_ar").limit(1).single()).data!.id;
    supervisor = await fx.user("rem-sup", { org_unit_id: unitId });
    employee = await fx.user("rem-emp", { org_unit_id: unitId, supervisor_id: supervisor.profileId });
    manager = await fx.user("rem-mgr", { org_unit_id: unitId });
    committee = await fx.user("rem-cmt", { org_unit_id: unitId });
    hr = await fx.user("rem-hr", { org_unit_id: unitId });
    const grant = async (u: TempUser, code: string) =>
      admin.from("user_roles").insert({ user_id: u.authUserId, role_id: await fx.roleId(code), scope_type: "all" });
    await grant(employee, "employee");
    await grant(supervisor, "supervisor");
    await grant(manager, "manager");
    await grant(committee, "committee");
    await grant(hr, "hr_admin");
    cycleId = (await admin.from("evaluation_cycles").insert({
      name_ar: `دورة تذكير ${fx.tag}`, start_date: "2026-01-01", end_date: "2026-12-31", cycle_type: "calendar",
      deadline_submit: "2026-03-31", deadline_supervisor: "2026-04-15", deadline_recommend: "2026-04-30", deadline_approve: "2026-05-15",
    }).select("id").single()).data!.id;
    evaluationId = (await admin.from("evaluations").insert({ employee_id: employee.profileId, cycle_id: cycleId, eval_type: "supervisor", state: "submitted" }).select("id").single()).data!.id;
  });

  afterAll(async () => {
    await admin.from("notifications").delete().eq("entity_id", evaluationId);
    await admin.from("evaluations").delete().eq("cycle_id", cycleId);
    await admin.from("evaluation_cycles").delete().eq("id", cycleId);
    await fx.cleanup();
  });

  const actors = async (state: string) => {
    const { data } = await admin.rpc("evaluation_actor_profile_ids", { p_evaluation_id: evaluationId, p_state: state });
    return new Set(((data ?? []) as unknown as Array<string | { evaluation_actor_profile_ids: string }>).map((r) => (typeof r === "string" ? r : r.evaluation_actor_profile_ids)));
  };

  it("names the right actor for each state, by relationship", async () => {
    expect((await actors("draft")).has(employee.profileId)).toBe(true);
    expect(await actors("submitted")).toEqual(new Set([supervisor.profileId]));
    const atManager = await actors("supervisor_reviewed");
    expect(atManager.has(manager.profileId)).toBe(true);
    expect(atManager.has(committee.profileId)).toBe(false);
    const atCommittee = await actors("manager_recommended");
    expect(atCommittee.has(committee.profileId)).toBe(true);
    expect(atCommittee.has(manager.profileId)).toBe(false);
    const atHr = await actors("committee_reviewed");
    expect(atHr.has(hr.profileId)).toBe(true);
    expect(atHr.has(supervisor.profileId)).toBe(false);
    expect((await actors("finalized")).size).toBe(0);
  });

  it("the deadlines must stay ordered", async () => {
    const { error } = await admin.from("evaluation_cycles").update({ deadline_supervisor: "2026-03-01" }).eq("id", cycleId);
    expect(error?.code).toBe("23514");
  });

  it("sends the week reminder to the supervisor once, then the day and overdue reminders, never repeating", async () => {
    const nothingYet = await runEvaluationReminders(admin, "2026-04-01", cycleId); // 14 days before 04-15
    expect(nothingYet).toMatchObject({ due: 0, sent: 0 });

    const week = await runEvaluationReminders(admin, "2026-04-10", cycleId);
    expect(week).toMatchObject({ due: 1, sent: 1, skippedAlreadySent: 0 });
    const again = await runEvaluationReminders(admin, "2026-04-11", cycleId);
    expect(again).toMatchObject({ due: 1, sent: 0, skippedAlreadySent: 1 });

    const day = await runEvaluationReminders(admin, "2026-04-15", cycleId);
    expect(day).toMatchObject({ sent: 1 });
    const overdue = await runEvaluationReminders(admin, "2026-04-20", cycleId);
    expect(overdue).toMatchObject({ sent: 1 });

    const { data } = await admin.from("notifications").select("recipient_id, type, message_ar, link_path").eq("entity_id", evaluationId).order("created_at");
    expect(data!.map((n) => n.type)).toEqual(["evaluation_reminder_week", "evaluation_reminder_day", "evaluation_reminder_overdue"]);
    expect(data!.every((n) => n.recipient_id === supervisor.profileId)).toBe(true);
    expect(data![0].link_path).toBe(`/evaluations/${evaluationId}`);
    expect(data![2].message_ar).toMatch(/تجاوز|فات/);
  });
});
