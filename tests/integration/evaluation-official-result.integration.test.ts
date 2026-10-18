import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { adminClient, asService, asUser, Fixtures, hasDatabase, pgClient, type TempUser } from "./helpers";

/**
 * 20261018000002 — the official result is stored at approval, finalize needs
 * it, reopen retires it with a reason, and all three run atomically inside
 * SECURITY DEFINER functions that check the approver themselves.
 */
describe.skipIf(!hasDatabase)("official evaluation result (approve / finalize / reopen)", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  let c: Client;
  let employee: TempUser, supervisor: TempUser, hr: TempUser, stranger: TempUser;
  let unitId: string;
  const snapshot = JSON.stringify({
    weights: { activities: 25, competencies: 25, bau: 25, feedback360: 25 },
    weights_source: "cycle",
    method_scores: { activities: null, competencies: 85, bau: 70, feedback360: null },
    final_score: 77.5, applied_weight: 50, missing_methods: ["activities", "feedback360"],
    rating_band: "good", feedback360_percent: null, scores_count: 3,
  });

  beforeAll(async () => {
    c = await pgClient();
    unitId = (await c.query("SELECT id FROM org_units WHERE deleted_at IS NULL ORDER BY name_ar LIMIT 1")).rows[0].id;
    supervisor = await fx.user("rsup", { org_unit_id: unitId });
    employee = await fx.user("remp", { org_unit_id: unitId, supervisor_id: supervisor.profileId });
    hr = await fx.user("rhr", { org_unit_id: unitId });
    stranger = await fx.user("rstr", { org_unit_id: unitId });
    const grant = async (u: TempUser, code: string) =>
      admin.from("user_roles").insert({ user_id: u.authUserId, role_id: await fx.roleId(code), scope_type: "all" });
    await grant(employee, "employee");
    await grant(supervisor, "supervisor");
    await grant(hr, "hr_admin");
    await grant(stranger, "employee");
  });

  afterAll(async () => {
    await fx.cleanup();
    await c.end();
  });

  async function inTransaction(state: string, fn: (evalId: string) => Promise<void>) {
    await c.query("BEGIN");
    try {
      const cycle = (await c.query("INSERT INTO evaluation_cycles(name_ar,start_date,end_date,cycle_type) VALUES ('دورة اختبار النتيجة','2026-01-01','2026-12-31','calendar') RETURNING id")).rows[0].id;
      const ev = (await c.query("INSERT INTO evaluations(employee_id,cycle_id,eval_type,state) VALUES ($1,$2,'supervisor',$3) RETURNING id", [employee.profileId, cycle, state])).rows[0].id;
      await fn(ev);
    } finally {
      await c.query("ROLLBACK");
    }
  }
  const current = (ev: string) => c.query("SELECT final_score, rating_band, org_unit_id, supervisor_id, approved_by, superseded_at, reopen_reason FROM evaluation_results WHERE evaluation_id=$1 ORDER BY created_at", [ev]);

  it("approve stores the snapshot with the employee's unit and supervisor, and moves the state, in one call", async () => {
    await inTransaction("committee_reviewed", async (ev) => {
      await asUser(c, hr.authUserId);
      const r = await c.query("SELECT approve_evaluation_with_result($1, $2::jsonb) AS id", [ev, snapshot]);
      expect(r.rows[0].id).toBeTruthy();
      await asService(c);
      expect((await c.query("SELECT state FROM evaluations WHERE id=$1", [ev])).rows[0].state).toBe("approved");
      const rows = (await current(ev)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ final_score: "77.50", rating_band: "good", org_unit_id: unitId, supervisor_id: supervisor.profileId, approved_by: hr.authUserId, superseded_at: null });
    });
  });

  it("a non-approver cannot approve, even with a perfect snapshot; the state is untouched", async () => {
    await inTransaction("committee_reviewed", async (ev) => {
      await asUser(c, supervisor.authUserId);
      await c.query("SAVEPOINT s");
      await expect(c.query("SELECT approve_evaluation_with_result($1, $2::jsonb)", [ev, snapshot])).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT s");
      await asService(c);
      expect((await c.query("SELECT state FROM evaluations WHERE id=$1", [ev])).rows[0].state).toBe("committee_reviewed");
      expect((await current(ev)).rowCount).toBe(0);
    });
  });

  it("approve refuses a wrong state and an incomplete snapshot", async () => {
    await inTransaction("submitted", async (ev) => {
      await asUser(c, hr.authUserId);
      await expect(c.query("SELECT approve_evaluation_with_result($1, $2::jsonb)", [ev, snapshot])).rejects.toMatchObject({ code: "23514" });
    });
    await inTransaction("committee_reviewed", async (ev) => {
      await asUser(c, hr.authUserId);
      await expect(c.query("SELECT approve_evaluation_with_result($1, '{}'::jsonb)", [ev])).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("finalize needs a stored result; reopen retires the result with the reason and moves the state back", async () => {
    await inTransaction("approved", async (ev) => {
      await asUser(c, hr.authUserId);
      await c.query("SAVEPOINT s");
      await expect(c.query("SELECT finalize_evaluation($1)", [ev])).rejects.toMatchObject({ code: "23514" }); // no result yet
      await c.query("ROLLBACK TO SAVEPOINT s");
      // Reopen back to committee_reviewed, approve properly, then finalize.
      await c.query("SELECT reopen_evaluation($1, 'committee_reviewed', 'إعادة فتح للتجربة')", [ev]);
      await c.query("SELECT approve_evaluation_with_result($1, $2::jsonb)", [ev, snapshot]);
      await c.query("SELECT finalize_evaluation($1)", [ev]);
      await asService(c);
      expect((await c.query("SELECT state FROM evaluations WHERE id=$1", [ev])).rows[0].state).toBe("finalized");
      // Reopen from finalized retires the result and records why.
      await asUser(c, hr.authUserId);
      await c.query("SAVEPOINT t");
      await expect(c.query("SELECT reopen_evaluation($1, 'submitted', 'قصير')", [ev])).rejects.toMatchObject({ code: "23514" });
      await c.query("ROLLBACK TO SAVEPOINT t");
      await c.query("SELECT reopen_evaluation($1, 'submitted', 'تصحيح درجة بعد تظلّم الموظف')", [ev]);
      await asService(c);
      expect((await c.query("SELECT state FROM evaluations WHERE id=$1", [ev])).rows[0].state).toBe("submitted");
      const rows = (await current(ev)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].superseded_at).not.toBeNull();
      expect(rows[0].reopen_reason).toBe("تصحيح درجة بعد تظلّم الموظف");
    });
  });

  it("an incomplete snapshot is refused without an override reason, and stored with it (20261018000003)", async () => {
    const incomplete = JSON.parse(snapshot);
    incomplete.missing_required = ["activities", "bau"];
    await inTransaction("committee_reviewed", async (ev) => {
      await asUser(c, hr.authUserId);
      await c.query("SAVEPOINT s");
      await expect(c.query("SELECT approve_evaluation_with_result($1, $2::jsonb)", [ev, JSON.stringify(incomplete)])).rejects.toMatchObject({ code: "23514" });
      await c.query("ROLLBACK TO SAVEPOINT s");
      await c.query("SAVEPOINT t");
      await expect(c.query("SELECT approve_evaluation_with_result($1, $2::jsonb)", [ev, JSON.stringify({ ...incomplete, override_reason: "قصير" })])).rejects.toMatchObject({ code: "23514" });
      await c.query("ROLLBACK TO SAVEPOINT t");
      await c.query("SELECT approve_evaluation_with_result($1, $2::jsonb)", [ev, JSON.stringify({ ...incomplete, override_reason: "الموظف في إجازة طويلة ولا أنشطة مكلَّف بها" })]);
      await asService(c);
      const row = (await c.query("SELECT missing_required, approval_override_reason FROM evaluation_results WHERE evaluation_id=$1 AND superseded_at IS NULL", [ev])).rows[0];
      expect(row.missing_required).toEqual(["activities", "bau"]);
      expect(row.approval_override_reason).toBe("الموظف في إجازة طويلة ولا أنشطة مكلَّف بها");
      expect((await c.query("SELECT state FROM evaluations WHERE id=$1", [ev])).rows[0].state).toBe("approved");
    });
  });

  it("reopen is refused for non-approvers and for a non-earlier target", async () => {
    await inTransaction("approved", async (ev) => {
      await asUser(c, supervisor.authUserId);
      await c.query("SAVEPOINT s");
      await expect(c.query("SELECT reopen_evaluation($1, 'submitted', 'سبب كافٍ هنا')", [ev])).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT s");
      await asUser(c, hr.authUserId);
      await c.query("SAVEPOINT t");
      await expect(c.query("SELECT reopen_evaluation($1, 'finalized', 'سبب كافٍ هنا')", [ev])).rejects.toMatchObject({ code: "23514" });
      await c.query("ROLLBACK TO SAVEPOINT t");
    });
  });

  it("the employee and their supervisor can read the stored result; a stranger cannot", async () => {
    await inTransaction("committee_reviewed", async (ev) => {
      await asUser(c, hr.authUserId);
      await c.query("SELECT approve_evaluation_with_result($1, $2::jsonb)", [ev, snapshot]);
      await asUser(c, employee.authUserId);
      expect((await c.query("SELECT final_score FROM evaluation_results WHERE evaluation_id=$1", [ev])).rowCount).toBe(1);
      await asUser(c, supervisor.authUserId);
      expect((await c.query("SELECT final_score FROM evaluation_results WHERE evaluation_id=$1", [ev])).rowCount).toBe(1);
      await asUser(c, stranger.authUserId);
      expect((await c.query("SELECT final_score FROM evaluation_results WHERE evaluation_id=$1", [ev])).rowCount).toBe(0);
      // Nobody writes the table directly: no UPDATE/INSERT policy exists, so RLS
      // hides every row from the statement (0 rows) and an insert is refused.
      await asUser(c, hr.authUserId);
      expect((await c.query("UPDATE evaluation_results SET final_score=100 WHERE evaluation_id=$1", [ev])).rowCount).toBe(0);
      await c.query("SAVEPOINT u");
      await expect(
        c.query("INSERT INTO evaluation_results(evaluation_id,cycle_id,employee_id,weights,weights_source,method_scores,applied_weight) SELECT id, cycle_id, employee_id, '{}'::jsonb, 'cycle', '{}'::jsonb, 0 FROM evaluations WHERE id=$1", [ev])
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT u");
      await asService(c);
      expect((await c.query("SELECT final_score FROM evaluation_results WHERE evaluation_id=$1 AND superseded_at IS NULL", [ev])).rows[0].final_score).toBe("77.50");
    });
  });
});
