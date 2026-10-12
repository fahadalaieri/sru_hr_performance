import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { adminClient, asService, asUser, Fixtures, hasDatabase, pgClient, type TempUser } from "./helpers";

/**
 * 20261012000001 — the 360 state machine lives in the database, closing the
 * two gaps an independent review found in the earlier lock:
 *  - a rater could UPDATE their own assignment back to `pending` through
 *    PostgREST (the update policy never constrained status);
 *  - the external save action checked `pending` and then wrote through the
 *    service role, which no policy constrains — a concurrent submit could land
 *    in between.
 * Both are now refused by triggers, which service_role cannot bypass.
 */
describe.skipIf(!hasDatabase)("three_sixty state machine triggers", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  let c: Client;
  let rater: TempUser, subject: TempUser, approver: TempUser;
  let ratingItemId: string;
  let option: { id: string };

  beforeAll(async () => {
    c = await pgClient();
    subject = await fx.user("subj");
    rater = await fx.user("rater");
    approver = await fx.user("approver");
    ratingItemId = (await c.query("SELECT id FROM three_sixty_items WHERE deleted_at IS NULL AND item_type='rating' LIMIT 1")).rows[0].id;
    option = (await c.query("SELECT id FROM three_sixty_rating_scale_options WHERE scale_code='behavior_freq_5' AND deleted_at IS NULL ORDER BY numeric_value DESC LIMIT 1")).rows[0];
  });

  afterAll(async () => {
    await fx.cleanup();
    await c.end();
  });

  async function inTransaction(fn: (asg: string) => Promise<void>, status: "pending" | "submitted" = "pending") {
    await c.query("BEGIN");
    try {
      const ec = (await c.query("INSERT INTO evaluation_cycles(name_ar,start_date,end_date,cycle_type) VALUES ('دورة اختبار آلة الحالة','2026-01-01','2026-12-31','calendar') RETURNING id")).rows[0].id;
      const cyc = (await c.query("INSERT INTO three_sixty_cycles(cycle_code,name_ar,start_date,end_date,scale_code,evaluation_cycle_id,status) VALUES ($1,'360 آلة الحالة','2026-01-01','2026-12-31','behavior_freq_5',$2,'draft') RETURNING id", [`ITS-${fx.tag}`, ec])).rows[0].id;
      const asg = (await c.query("INSERT INTO three_sixty_assignments(cycle_id,subject_employee_id,rater_employee_id,relationship_code,status) VALUES ($1,$2,$3,'peer',$4) RETURNING id", [cyc, subject.profileId, rater.profileId, status])).rows[0].id;
      await fn(asg);
    } finally {
      await c.query("ROLLBACK");
    }
  }

  it("a rater cannot reopen a submitted assignment (the bypass the review found)", async () => {
    await inTransaction(async (asg) => {
      await asUser(c, rater.authUserId);
      await expect(c.query("UPDATE three_sixty_assignments SET status='pending' WHERE id=$1", [asg])).rejects.toMatchObject({ code: "23514" });
    }, "submitted");
  });

  it("a rater can still submit (pending → submitted) but may change nothing else", async () => {
    await inTransaction(async (asg) => {
      await asUser(c, rater.authUserId);
      await c.query("SAVEPOINT s");
      await expect(c.query("UPDATE three_sixty_assignments SET relationship_code='supervisor' WHERE id=$1", [asg])).rejects.toMatchObject({ code: "23514" });
      await c.query("ROLLBACK TO SAVEPOINT s");
      const r = await c.query("UPDATE three_sixty_assignments SET status='submitted' WHERE id=$1 AND status='pending'", [asg]);
      expect(r.rowCount).toBe(1);
    });
  });

  it("even the service role cannot write an answer once the assignment is submitted (closes the save/submit race)", async () => {
    await inTransaction(async (asg) => {
      // The connection runs as the database owner here: no RLS, like service_role.
      await expect(c.query("INSERT INTO three_sixty_responses(assignment_id,item_id,option_id) VALUES ($1,$2,$3)", [asg, ratingItemId, option.id])).rejects.toMatchObject({ code: "23514" });
    }, "submitted");
  });

  it("the service role can still write while pending (the external path's normal case)", async () => {
    await inTransaction(async (asg) => {
      const r = await c.query("INSERT INTO three_sixty_responses(assignment_id,item_id,option_id) VALUES ($1,$2,$3) RETURNING id", [asg, ratingItemId, option.id]);
      expect(r.rowCount).toBe(1);
    });
  });

  it("a signed-in approve holder may still correct an answer after submission", async () => {
    await inTransaction(async (asg) => {
      const resp = (await c.query("INSERT INTO three_sixty_responses(assignment_id,item_id,option_id) VALUES ($1,$2,$3) RETURNING id", [asg, ratingItemId, option.id])).rows[0].id;
      await c.query("UPDATE three_sixty_assignments SET status='submitted' WHERE id=$1", [asg]);
      // A temporary role holding threeSixty=approve, scope all — the documented administrative exception.
      const role = (await c.query("INSERT INTO roles(role_code,name_ar,name_en,is_system_role) VALUES ($1,'دور اختبار 360','tmp 360 approver',false) RETURNING id", [`tmp_360_approver_${fx.tag}`])).rows[0].id;
      await c.query("INSERT INTO role_permissions(role_id,process_area,vpra_level) VALUES ($1,'threeSixty','approve')", [role]);
      await c.query("INSERT INTO user_roles(user_id,role_id,scope_type) VALUES ($1,$2,'all')", [approver.authUserId, role]);
      const lower = (await c.query("SELECT id FROM three_sixty_rating_scale_options WHERE scale_code='behavior_freq_5' AND deleted_at IS NULL ORDER BY numeric_value ASC LIMIT 1")).rows[0].id;
      await asUser(c, approver.authUserId);
      const r = await c.query("UPDATE three_sixty_responses SET option_id=$2 WHERE id=$1", [resp, lower]);
      expect(r.rowCount).toBe(1);
      await asService(c);
    });
  });
});
