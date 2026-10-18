import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { adminClient, asService, asUser, Fixtures, hasDatabase, pgClient, type TempUser } from "./helpers";

/**
 * 20261018000001 — the evaluation state machine lives in the database:
 * one forward step by the real relationship, reopen for approvers only, no
 * skipping, scores locked after approval, weights frozen once a cycle has a
 * submitted evaluation. RLS is simulated the way every migration here was
 * verified (SET ROLE authenticated + a JWT claim), inside transactions that
 * are rolled back.
 */
describe.skipIf(!hasDatabase)("evaluation state machine triggers", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  let c: Client;
  let employee: TempUser, supervisor: TempUser, manager: TempUser, committee: TempUser, hr: TempUser, stranger: TempUser;
  let unitId: string;
  let competencyId: string;

  beforeAll(async () => {
    c = await pgClient();
    unitId = (await c.query("SELECT id FROM org_units WHERE deleted_at IS NULL ORDER BY name_ar LIMIT 1")).rows[0].id;
    competencyId = (await c.query("SELECT id FROM competencies WHERE deleted_at IS NULL LIMIT 1")).rows[0].id;
    supervisor = await fx.user("sup", { org_unit_id: unitId });
    employee = await fx.user("emp", { org_unit_id: unitId, supervisor_id: supervisor.profileId });
    manager = await fx.user("mgr", { org_unit_id: unitId });
    committee = await fx.user("cmt", { org_unit_id: unitId });
    hr = await fx.user("hr", { org_unit_id: unitId });
    stranger = await fx.user("str", { org_unit_id: unitId });
    const grant = async (u: TempUser, code: string) =>
      admin.from("user_roles").insert({ user_id: u.authUserId, role_id: await fx.roleId(code), scope_type: "all" });
    await grant(employee, "employee");
    await grant(supervisor, "supervisor");
    await grant(manager, "manager"); // seeded: evaluation=recommend
    await grant(committee, "committee");
    await grant(hr, "hr_admin"); // seeded: evaluation=approve
    await grant(stranger, "employee");
  });

  afterAll(async () => {
    await fx.cleanup();
    await c.end();
  });

  async function inTransaction(state: string, fn: (evalId: string, cycleId: string) => Promise<void>) {
    await c.query("BEGIN");
    try {
      const cycle = (await c.query("INSERT INTO evaluation_cycles(name_ar,start_date,end_date,cycle_type) VALUES ('دورة اختبار آلة الحالة','2026-01-01','2026-12-31','calendar') RETURNING id")).rows[0].id;
      const ev = (await c.query("INSERT INTO evaluations(employee_id,cycle_id,eval_type,state) VALUES ($1,$2,'supervisor',$3) RETURNING id", [employee.profileId, cycle, state])).rows[0].id;
      await fn(ev, cycle);
    } finally {
      await c.query("ROLLBACK");
    }
  }
  const move = (id: string, to: string) => c.query("UPDATE evaluations SET state=$2 WHERE id=$1", [id, to]);
  const refused = async (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: "23514" });

  it("the employee cannot jump their own draft to approved (the bypass the review found)", async () => {
    await inTransaction("draft", async (ev) => {
      await asUser(c, employee.authUserId);
      await refused(move(ev, "approved"));
    });
  });

  it("the employee can submit their own draft; a stranger holding the same role cannot", async () => {
    await inTransaction("draft", async (ev) => {
      await asUser(c, stranger.authUserId);
      await c.query("SAVEPOINT s");
      // RLS hides the row from the stranger (0 rows) or the trigger refuses — either way nothing moves.
      const r = await move(ev, "submitted").catch((e) => e);
      await c.query("ROLLBACK TO SAVEPOINT s");
      await asService(c);
      expect((await c.query("SELECT state FROM evaluations WHERE id=$1", [ev])).rows[0].state).toBe("draft");
      void r;
      await asUser(c, employee.authUserId);
      expect((await move(ev, "submitted")).rowCount).toBe(1);
    });
  });

  it("only the direct supervisor moves submitted → supervisor_reviewed; the manager may not, and nobody may skip", async () => {
    await inTransaction("submitted", async (ev) => {
      await asUser(c, manager.authUserId);
      await c.query("SAVEPOINT s");
      await refused(move(ev, "supervisor_reviewed"));
      await c.query("ROLLBACK TO SAVEPOINT s");
      await asUser(c, supervisor.authUserId);
      await c.query("SAVEPOINT t");
      await refused(move(ev, "manager_recommended")); // skip
      await c.query("ROLLBACK TO SAVEPOINT t");
      expect((await move(ev, "supervisor_reviewed")).rowCount).toBe(1);
    });
  });

  it("manager (recommend in scope) → committee (role) → hr (approve) → finalized, each by its own actor", async () => {
    await inTransaction("supervisor_reviewed", async (ev) => {
      await asUser(c, committee.authUserId);
      await c.query("SAVEPOINT s");
      await refused(move(ev, "manager_recommended"));
      await c.query("ROLLBACK TO SAVEPOINT s");
      await asUser(c, manager.authUserId);
      expect((await move(ev, "manager_recommended")).rowCount).toBe(1);
      await c.query("SAVEPOINT u");
      await refused(move(ev, "committee_reviewed")); // manager is not the committee
      await c.query("ROLLBACK TO SAVEPOINT u");
      await asUser(c, committee.authUserId);
      expect((await move(ev, "committee_reviewed")).rowCount).toBe(1);
      await c.query("SAVEPOINT v");
      await refused(move(ev, "approved")); // committee cannot approve
      await c.query("ROLLBACK TO SAVEPOINT v");
      await asUser(c, hr.authUserId);
      expect((await move(ev, "approved")).rowCount).toBe(1);
      expect((await move(ev, "finalized")).rowCount).toBe(1);
    });
  });

  it("reopen (backwards) is for approvers only", async () => {
    await inTransaction("approved", async (ev) => {
      await asUser(c, supervisor.authUserId);
      await c.query("SAVEPOINT s");
      await refused(move(ev, "submitted"));
      await c.query("ROLLBACK TO SAVEPOINT s");
      await asUser(c, hr.authUserId);
      expect((await move(ev, "submitted")).rowCount).toBe(1);
    });
  });

  it("scores lock at approved (approver may still correct) and at finalized (nobody)", async () => {
    await inTransaction("approved", async (ev) => {
      await asUser(c, supervisor.authUserId);
      await c.query("SAVEPOINT s");
      await refused(c.query("INSERT INTO evaluation_scores(evaluation_id,competency_id,score) VALUES ($1,$2,90)", [ev, competencyId]));
      await c.query("ROLLBACK TO SAVEPOINT s");
      await asUser(c, hr.authUserId);
      expect((await c.query("INSERT INTO evaluation_scores(evaluation_id,competency_id,score) VALUES ($1,$2,90) RETURNING id", [ev, competencyId])).rowCount).toBe(1);
      expect((await move(ev, "finalized")).rowCount).toBe(1);
      await c.query("SAVEPOINT t");
      await refused(c.query("UPDATE evaluation_scores SET score=10 WHERE evaluation_id=$1", [ev]));
      await c.query("ROLLBACK TO SAVEPOINT t");
      // No DELETE policy exists for authenticated: RLS hides every row, so the
      // statement touches nothing (the trigger guards the owner/service path).
      expect((await c.query("DELETE FROM evaluation_scores WHERE evaluation_id=$1", [ev])).rowCount).toBe(0);
      await asService(c);
      expect((await c.query("SELECT count(*)::int n FROM evaluation_scores WHERE evaluation_id=$1", [ev])).rows[0].n).toBe(1);
    });
  });

  it("scores can be written while in review; identity columns never change", async () => {
    await inTransaction("submitted", async (ev) => {
      await asUser(c, supervisor.authUserId);
      expect((await c.query("INSERT INTO evaluation_scores(evaluation_id,competency_id,score) VALUES ($1,$2,75) RETURNING id", [ev, competencyId])).rowCount).toBe(1);
      await refused(c.query("UPDATE evaluations SET eval_type='self' WHERE id=$1", [ev]));
    });
  });

  it("weights freeze once any evaluation in the cycle left draft; service role is not constrained", async () => {
    await inTransaction("draft", async (ev, cycle) => {
      await asUser(c, hr.authUserId);
      expect((await c.query("UPDATE evaluation_cycles SET weight_bau=30, weight_competencies=20 WHERE id=$1", [cycle])).rowCount).toBe(1);
      await asUser(c, employee.authUserId);
      expect((await move(ev, "submitted")).rowCount).toBe(1);
      await asUser(c, hr.authUserId);
      await c.query("SAVEPOINT s");
      await refused(c.query("UPDATE evaluation_cycles SET weight_bau=40, weight_competencies=10 WHERE id=$1", [cycle]));
      await c.query("ROLLBACK TO SAVEPOINT s");
      await c.query("SAVEPOINT t");
      await refused(c.query("INSERT INTO org_unit_evaluation_weights(cycle_id,org_unit_id,weight_activities,weight_competencies,weight_bau,weight_feedback_360) VALUES ($1,$2,25,25,25,25)", [cycle, unitId]));
      await c.query("ROLLBACK TO SAVEPOINT t");
      // Renaming the cycle is still allowed: only the weight columns are frozen.
      expect((await c.query("UPDATE evaluation_cycles SET name_ar='اسم جديد' WHERE id=$1", [cycle])).rowCount).toBe(1);
      // Owner/service path (no JWT claim): not constrained. RESET ROLE alone
      // keeps the transaction-local claim, so clear it explicitly.
      await asService(c);
      await c.query("SELECT set_config('request.jwt.claims', '', true)");
      expect((await c.query("UPDATE evaluation_cycles SET weight_bau=40, weight_competencies=10 WHERE id=$1", [cycle])).rowCount).toBe(1);
    });
  });
});
