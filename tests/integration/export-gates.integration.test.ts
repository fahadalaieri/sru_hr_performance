import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, anonClient, env, Fixtures, hasDatabase, sessionCookie, type TempUser } from "./helpers";

/**
 * Export Route Handlers (src/app/api/** /export) through HTTP against the
 * running dev server. Needs INTEGRATION_BASE_URL (e.g. http://localhost:3317);
 * skipped otherwise. The expected outcome per route is computed from the
 * caller's REAL get_my_permissions rows with the same OR-gate rule the routes
 * declare, so this test cannot drift from the matrix.
 */
const gates: Record<string, Array<[string, string]>> = {
  "employees/export": [],
  "vacancies/export": [],
  "org-units/export": [],
  "promotions/export": [],
  "strategic-plans/00000000-0000-4000-8000-000000000000/export": [],
  "org-structure/staffing/export": [["orgStructure", "view"], ["staffing", "view"]],
  "three-sixty/template/export": [["threeSixty", "prepare"]],
  "recruitment/plan/00000000-0000-4000-8000-000000000000/export": [["recruitmentPlan", "view"], ["recruitmentBudget", "recommend"]],
  "competencies/export": [["competencyFramework", "view"]],
  "recruitment/requests/export": [["recruitmentRequests", "view"], ["recruitmentBudget", "view"]],
};
const rank: Record<string, number> = { none: 0, view: 1, prepare: 2, recommend: 3, approve: 4 };

describe.skipIf(!hasDatabase || !env.baseUrl)("export routes: 401 without a session, 403/200 by the caller's real permissions", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  let employee: TempUser;

  beforeAll(async () => {
    employee = await fx.user("exp");
    await admin.from("user_roles").insert({ user_id: employee.authUserId, role_id: await fx.roleId("employee"), scope_type: "all" });
  });
  afterAll(async () => fx.cleanup());

  it("every route answers 401 to an unauthenticated caller", async () => {
    for (const route of Object.keys(gates)) {
      const r = await fetch(`${env.baseUrl}/api/${route}?format=xlsx`);
      expect(r.status, route).toBe(401);
    }
  });

  it("a plain employee gets exactly what the gate rule predicts from their own permission rows", async () => {
    const sb = anonClient();
    const { data, error } = await sb.auth.signInWithPassword({ email: employee.email, password: employee.password });
    expect(error).toBeNull();
    const { data: perms } = await sb.rpc("get_my_permissions");
    const map = Object.fromEntries(((perms ?? []) as Array<{ process_area: string; vpra_level: string }>).map((r) => [r.process_area, r.vpra_level]));
    const cookie = sessionCookie(data.session!);
    for (const [route, gate] of Object.entries(gates)) {
      const passes = gate.length === 0 || gate.some(([a, l]) => rank[map[a] ?? "none"] >= rank[l]);
      const r = await fetch(`${env.baseUrl}/api/${route}?format=xlsx`, { headers: { cookie } });
      if (passes) expect([200, 404], route).toContain(r.status);
      else expect(r.status, route).toBe(403);
    }
    await sb.auth.signOut();
  });
});
