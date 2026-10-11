import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { adminClient, anonClient, asService, asUser, Fixtures, hasDatabase, pgClient, type TempUser } from "./helpers";

/**
 * operational_plan_target_employees_select (20261007000002): the employee, a
 * supervisor in the chain, or a strategicPlanning>=view holder whose scope
 * covers the share's org unit — and nobody else. Plus org_units_kind_backup
 * is unreadable to authenticated and anon.
 */
describe.skipIf(!hasDatabase)("operational_plan_target_employees RLS + archive table", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  let c: Client;
  let units: { child: string; sibling: string; parent: string };
  let owner: TempUser, unrelated: TempUser, supervisor: TempUser, scopedParent: TempUser, scopedSibling: TempUser, global: TempUser;

  beforeAll(async () => {
    c = await pgClient();
    // A real parent unit with at least two live children — the tree is seeded by migrations, so this is stable.
    const row = (await c.query(`
      SELECT p.id AS parent, (array_agg(ch.id ORDER BY ch.name_ar))[1] AS child, (array_agg(ch.id ORDER BY ch.name_ar))[2] AS sibling
      FROM org_units p JOIN org_units ch ON ch.parent_id = p.id AND ch.deleted_at IS NULL
      WHERE p.deleted_at IS NULL GROUP BY p.id HAVING count(*) >= 2 LIMIT 1`)).rows[0];
    units = { parent: row.parent, child: row.child, sibling: row.sibling };
    owner = await fx.user("owner", { org_unit_id: units.child });
    unrelated = await fx.user("unrelated", { org_unit_id: units.sibling });
    supervisor = await fx.user("sup", { org_unit_id: units.sibling });
    scopedParent = await fx.user("mparent", { org_unit_id: units.parent });
    scopedSibling = await fx.user("msibling", { org_unit_id: units.sibling });
    global = await fx.user("global");
    await admin.from("profiles").update({ supervisor_id: supervisor.profileId }).eq("id", owner.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
    await c.end();
  });

  it("only the owner, the supervisor chain, and in-scope strategicPlanning viewers can read a share", async () => {
    await c.query("BEGIN");
    try {
      const ceo = (await c.query("SELECT id FROM roles WHERE role_code='ceo'")).rows[0].id; // holds strategicPlanning=view in the seeded matrix
      await c.query(
        "INSERT INTO user_roles(user_id, role_id, scope_type, org_unit_id) VALUES ($1,$2,'org_unit',$3),($4,$2,'org_unit',$5),($6,$2,'all',NULL)",
        [scopedParent.authUserId, ceo, units.parent, scopedSibling.authUserId, units.sibling, global.authUserId]
      );
      const sp = (await c.query("INSERT INTO strategic_plans(name_ar,start_year,end_year) VALUES ('خطة اختبار تكامل',2026,2027) RETURNING id")).rows[0].id;
      const sg = (await c.query("INSERT INTO strategic_goals(plan_id,title_ar) VALUES ($1,'هدف') RETURNING id", [sp])).rows[0].id;
      const kpi = (await c.query("INSERT INTO strategic_kpis(strategic_goal_id,title_ar,unit_ar) VALUES ($1,'مؤشر','%') RETURNING id", [sg])).rows[0].id;
      const op = (await c.query("INSERT INTO operational_plans(strategic_plan_id,name_ar,start_date,end_date) VALUES ($1,'خطة تشغيلية','2026-01-01','2026-12-31') RETURNING id", [sp])).rows[0].id;
      const tg = (await c.query("INSERT INTO operational_plan_targets(executive_plan_id,strategic_kpi_id,target_value) VALUES ($1,$2,100) RETURNING id", [op, kpi])).rows[0].id;
      const tu = (await c.query("INSERT INTO operational_plan_target_org_units(executive_plan_target_id,org_unit_id,percentage) VALUES ($1,$2,50) RETURNING id", [tg, units.child])).rows[0].id;
      await c.query("INSERT INTO operational_plan_target_employees(target_org_unit_id,employee_id,percentage,actual_value) VALUES ($1,$2,30,12)", [tu, owner.profileId]);

      const visible = async (u: TempUser) => {
        await asUser(c, u.authUserId);
        const n = (await c.query("SELECT count(*)::int AS n FROM operational_plan_target_employees WHERE target_org_unit_id=$1", [tu])).rows[0].n;
        await asService(c);
        return n;
      };
      expect(await visible(owner)).toBe(1);
      expect(await visible(unrelated)).toBe(0);
      expect(await visible(supervisor)).toBe(1);
      expect(await visible(scopedParent)).toBe(1);
      expect(await visible(scopedSibling)).toBe(0);
      expect(await visible(global)).toBe(1);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("org_units_kind_backup is unreadable to authenticated and to anon", async () => {
    await c.query("BEGIN");
    try {
      await asUser(c, global.authUserId);
      await expect(c.query("SELECT count(*) FROM org_units_kind_backup")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("ROLLBACK");
    }
    const r = await anonClient().from("org_units_kind_backup").select("id").limit(1);
    expect(r.error?.code).toBe("42501");
  });
});
