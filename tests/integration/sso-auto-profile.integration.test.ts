import { afterAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { adminClient, env, hasDatabase } from "./helpers";
import { parseAssertionSecrets } from "../../src/lib/ssoAssertion";

/**
 * A university account with no HR profile (2026-10-15 decision): the first SSO
 * visit creates a PENDING profile from the SSO directory hints and refuses the
 * login until HR approves; approval then lets the next visit in normally.
 */
const appKey = process.env.NEXT_PUBLIC_SRU_SSO_APP_KEY ?? "";
const secrets = parseAssertionSecrets(process.env.SRU_SSO_ASSERTION_SECRETS);
const kid = Object.keys(secrets).sort().pop() ?? "";
const enabled = hasDatabase && Boolean(env.baseUrl) && Boolean(appKey) && Boolean(kid);

const b64 = (s: string) => Buffer.from(s).toString("base64url");
function mint(email: string, name: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT", kid }));
  const payload = b64(JSON.stringify({ iss: "sru-sso", aud: appKey, sub: randomUUID(), email, name, role: "viewer", iat: now, exp: now + 60, jti: randomUUID() }));
  const body = `${header}.${payload}`;
  return `${body}.${createHmac("sha256", secrets[kid]).update(body).digest("base64url")}`;
}
const post = (assertion: string, directory?: Record<string, string | null>) =>
  fetch(`${env.baseUrl}/api/sso/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion, locale: "ar", directory }) });

describe.skipIf(!enabled)("/api/sso/callback — auto-created pending profile", () => {
  const admin = adminClient();
  const tag = Date.now().toString(36);
  const email = `tmp-it-sso-auto-${tag}@sru-dev.internal`;
  let profileId: string | null = null;
  let authUserId: string | null = null;

  afterAll(async () => {
    if (authUserId) await admin.auth.admin.deleteUser(authUserId);
    if (profileId) await admin.from("profiles").delete().eq("id", profileId);
    await admin.from("sso_assertion_jti").delete().eq("email", email);
    await admin.from("audit_log").delete().eq("after_data->>email", email);
  });

  it("first visit: creates a pending profile from the directory hints and refuses the login with profile_pending", async () => {
    const { data: unit } = await admin.from("org_units").select("id, name_ar").is("deleted_at", null).limit(1).single();
    const res = await post(mint(email, "موظف جديد عبر الدليل"), { nameAr: "اسم من الدليل", department: unit!.name_ar, positionAr: "مسمّى غير موجود في المنصة" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("profile_pending");

    const { data: p } = await admin.from("profiles").select("id, employee_number, full_name_ar, approval_status, org_unit_id, job_title_id, auth_user_id").eq("email", email).single();
    profileId = p!.id;
    expect(p!.approval_status).toBe("pending");
    expect(p!.full_name_ar).toBe("موظف جديد عبر الدليل"); // the SIGNED name wins over the unsigned hint
    expect(p!.employee_number).toMatch(/^SSO-/);
    expect(p!.org_unit_id).toBe(unit!.id); // exact department name matched a real org unit
    expect(p!.job_title_id).toBeNull(); // unknown position stays empty for HR
    expect(p!.auth_user_id).toBeNull(); // no account until approved
    const { data: audit } = await admin.from("audit_log").select("after_data").eq("action", "sso_profile_created_pending").eq("entity_id", profileId);
    expect(audit?.length).toBe(1);
    expect((audit![0].after_data as { sso_position: string }).sso_position).toBe("مسمّى غير موجود في المنصة");
  });

  it("second visit while still pending: no duplicate profile, same answer", async () => {
    const res = await post(mint(email, "موظف جديد عبر الدليل"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("profile_pending");
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("email", email);
    expect(count).toBe(1);
  });

  it("after HR approval: the next visit logs in, links the account and grants the employee role", async () => {
    await admin.from("profiles").update({ approval_status: "approved" }).eq("id", profileId!);
    const res = await post(mint(email, "موظف جديد عبر الدليل"));
    expect(res.status).toBe(200);
    const { data: p } = await admin.from("profiles").select("auth_user_id").eq("id", profileId!).single();
    expect(p!.auth_user_id).toBeTruthy();
    authUserId = p!.auth_user_id as string;
    const { data: roles } = await admin.from("user_roles").select("roles(role_code)").eq("user_id", authUserId);
    expect((roles![0] as unknown as { roles: { role_code: string } }).roles.role_code).toBe("employee");
  });
});
