import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { adminClient, asService, asUser, Fixtures, hasDatabase, pgClient, type TempUser } from "./helpers";

/**
 * Locks introduced on 2026-10-06/07 for the 360 module:
 *  - three_sixty_responses_insert/_update require the assignment to be `pending` (20261006000001)
 *  - validate_three_sixty_response() ties an option to its item's scale and derives the score (20261006000002)
 *  - submitting is a guarded status flip, so two concurrent submits cannot both win
 */
describe.skipIf(!hasDatabase)("three_sixty_responses: RLS lock, validation trigger, submit concurrency", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  let c: Client;
  let rater: TempUser;
  let subject: TempUser;
  let ratingItemId: string;
  let textItemId: string;
  let goodOption: { id: string; numeric_value: string };

  beforeAll(async () => {
    c = await pgClient();
    subject = await fx.user("subj");
    rater = await fx.user("rater");
    ratingItemId = (await c.query("SELECT id FROM three_sixty_items WHERE deleted_at IS NULL AND item_type='rating' LIMIT 1")).rows[0].id;
    textItemId = (await c.query("SELECT id FROM three_sixty_items WHERE deleted_at IS NULL AND item_type='open_text' LIMIT 1")).rows[0].id;
    goodOption = (await c.query("SELECT id, numeric_value FROM three_sixty_rating_scale_options WHERE scale_code='behavior_freq_5' AND deleted_at IS NULL ORDER BY numeric_value DESC LIMIT 1")).rows[0];
  });

  afterAll(async () => {
    await fx.cleanup();
    await c.end();
  });

  /** Everything inside one transaction that is always rolled back. */
  async function inTransaction(fn: (assignmentId: string) => Promise<void>, status: "pending" | "submitted" = "pending") {
    await c.query("BEGIN");
    try {
      const ec = (await c.query("INSERT INTO evaluation_cycles(name_ar,start_date,end_date,cycle_type) VALUES ('دورة اختبار تكامل','2026-01-01','2026-12-31','calendar') RETURNING id")).rows[0].id;
      const cyc = (await c.query("INSERT INTO three_sixty_cycles(cycle_code,name_ar,start_date,end_date,scale_code,evaluation_cycle_id,status) VALUES ($1,'360 اختبار تكامل','2026-01-01','2026-12-31','behavior_freq_5',$2,'active') RETURNING id", [`IT-${fx.tag}`, ec])).rows[0].id;
      const asg = (await c.query("INSERT INTO three_sixty_assignments(cycle_id,subject_employee_id,rater_employee_id,relationship_code,status) VALUES ($1,$2,$3,'peer',$4) RETURNING id", [cyc, subject.profileId, rater.profileId, status])).rows[0].id;
      await fn(asg);
    } finally {
      await c.query("ROLLBACK");
    }
  }

  it("a rater can insert an answer while the assignment is pending", async () => {
    await inTransaction(async (asg) => {
      await asUser(c, rater.authUserId);
      const r = await c.query("INSERT INTO three_sixty_responses(assignment_id,item_id,option_id) VALUES ($1,$2,$3) RETURNING numeric_value", [asg, ratingItemId, goodOption.id]);
      expect(Number(r.rows[0].numeric_value)).toBe(Number(goodOption.numeric_value));
    });
  });

  it("RLS refuses an insert once the assignment is submitted", async () => {
    await inTransaction(async (asg) => {
      await asUser(c, rater.authUserId);
      await expect(c.query("INSERT INTO three_sixty_responses(assignment_id,item_id,option_id) VALUES ($1,$2,$3)", [asg, ratingItemId, goodOption.id])).rejects.toMatchObject({ code: "42501" });
    }, "submitted");
  });

  it("an update after submission affects zero rows and leaves the stored value intact", async () => {
    await inTransaction(async (asg) => {
      const resp = (await c.query("INSERT INTO three_sixty_responses(assignment_id,item_id,option_id) VALUES ($1,$2,$3) RETURNING id", [asg, ratingItemId, goodOption.id])).rows[0].id;
      await c.query("UPDATE three_sixty_assignments SET status='submitted' WHERE id=$1", [asg]);
      const lower = (await c.query("SELECT id FROM three_sixty_rating_scale_options WHERE scale_code='behavior_freq_5' AND deleted_at IS NULL ORDER BY numeric_value ASC LIMIT 1")).rows[0].id;
      await asUser(c, rater.authUserId);
      const r = await c.query("UPDATE three_sixty_responses SET option_id=$2 WHERE id=$1", [resp, lower]);
      expect(r.rowCount).toBe(0);
      await asService(c);
      const v = await c.query("SELECT option_id FROM three_sixty_responses WHERE id=$1", [resp]);
      expect(v.rows[0].option_id).toBe(goodOption.id);
    });
  });

  it("the trigger refuses an option from another scale, an option on a text item, and a bare number", async () => {
    await inTransaction(async (asg) => {
      const other = (await c.query("INSERT INTO three_sixty_rating_scale_options(scale_code,option_code,label_ar,numeric_value) VALUES ('tmp_it_scale','x','مقياس آخر',9) RETURNING id")).rows[0].id;
      for (const sql of [
        ["INSERT INTO three_sixty_responses(assignment_id,item_id,option_id) VALUES ($1,$2,$3)", [asg, ratingItemId, other]],
        ["INSERT INTO three_sixty_responses(assignment_id,item_id,option_id) VALUES ($1,$2,$3)", [asg, textItemId, goodOption.id]],
        ["INSERT INTO three_sixty_responses(assignment_id,item_id,numeric_value) VALUES ($1,$2,4)", [asg, ratingItemId]],
      ] as const) {
        await c.query("SAVEPOINT s");
        await expect(c.query(sql[0], [...sql[1]])).rejects.toMatchObject({ code: "23514" });
        await c.query("ROLLBACK TO SAVEPOINT s");
      }
    });
  });

  it("the stored score is the option's value, never the client's number", async () => {
    await inTransaction(async (asg) => {
      await asUser(c, rater.authUserId);
      const r = await c.query("INSERT INTO three_sixty_responses(assignment_id,item_id,option_id,numeric_value) VALUES ($1,$2,$3,99) RETURNING numeric_value", [asg, ratingItemId, goodOption.id]);
      expect(Number(r.rows[0].numeric_value)).toBe(Number(goodOption.numeric_value));
    });
  });

  it("two concurrent submits of the same pending assignment: exactly one wins", async () => {
    // Needs committed rows visible to two connections, so this one is not
    // rolled back — it cleans up by exact id, child tables first (the
    // evaluation_cycles FK is RESTRICT, not CASCADE). The cycle is created as
    // `draft`: three_sixty_cycles_single_active_uidx allows one active cycle
    // per database, and a committed `active` fixture would collide with a
    // real one (or, after a failed run, with its own leftover).
    const c2 = await pgClient();
    const ids: { ec?: string; cyc?: string; asg?: string } = {};
    try {
      ids.ec = (await c.query("INSERT INTO evaluation_cycles(name_ar,start_date,end_date,cycle_type) VALUES ('دورة اختبار تزامن','2026-01-01','2026-12-31','calendar') RETURNING id")).rows[0].id;
      ids.cyc = (await c.query("INSERT INTO three_sixty_cycles(cycle_code,name_ar,start_date,end_date,scale_code,evaluation_cycle_id,status) VALUES ($1,'360 تزامن','2026-01-01','2026-12-31','behavior_freq_5',$2,'draft') RETURNING id", [`ITC-${fx.tag}`, ids.ec])).rows[0].id;
      ids.asg = (await c.query("INSERT INTO three_sixty_assignments(cycle_id,subject_employee_id,rater_employee_id,relationship_code,status) VALUES ($1,$2,$3,'peer','pending') RETURNING id", [ids.cyc, subject.profileId, rater.profileId])).rows[0].id;
      const flip = (client: Client) => client.query("UPDATE three_sixty_assignments SET status='submitted' WHERE id=$1 AND status='pending'", [ids.asg]);
      const [a, b] = await Promise.all([flip(c), flip(c2)]);
      expect((a.rowCount ?? 0) + (b.rowCount ?? 0)).toBe(1);
    } finally {
      await c2.end();
      if (ids.asg) await c.query("DELETE FROM three_sixty_assignments WHERE id=$1", [ids.asg]);
      if (ids.cyc) await c.query("DELETE FROM three_sixty_cycles WHERE id=$1", [ids.cyc]);
      if (ids.ec) await c.query("DELETE FROM evaluation_cycles WHERE id=$1", [ids.ec]);
    }
  });
});
