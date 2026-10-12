import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { adminClient, env, Fixtures, hasDatabase, type TempUser } from "./helpers";
import { parseAssertionSecrets } from "../../src/lib/ssoAssertion";

/**
 * /api/sso/callback end to end against the dev server. We play the identity
 * project: sign assertions locally with the dev secret in .env.local
 * (SRU_SSO_ASSERTION_SECRETS) exactly as `mint_assertion` does — HS256, kid,
 * 60-second life, aud = our app key. Needs INTEGRATION_BASE_URL and the two
 * SRU_SSO_* variables; skipped otherwise.
 */
const appKey = process.env.NEXT_PUBLIC_SRU_SSO_APP_KEY ?? "";
const secrets = parseAssertionSecrets(process.env.SRU_SSO_ASSERTION_SECRETS);
const kid = Object.keys(secrets).sort().pop() ?? "";
const enabled = hasDatabase && Boolean(env.baseUrl) && Boolean(appKey) && Boolean(kid);

const b64 = (s: string) => Buffer.from(s).toString("base64url");
function mint(email: string, overrides: Record<string, unknown> = {}, useKid = kid) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT", kid: useKid }));
  const payload = b64(JSON.stringify({ iss: "sru-sso", aud: appKey, sub: randomUUID(), email, name: "اختبار", role: "viewer", iat: now, exp: now + 60, jti: randomUUID(), ...overrides }));
  const body = `${header}.${payload}`;
  return `${body}.${createHmac("sha256", secrets[useKid] ?? "x").update(body).digest("base64url")}`;
}
const post = (assertion: string) =>
  fetch(`${env.baseUrl}/api/sso/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion, locale: "ar" }) });

describe.skipIf(!enabled)("/api/sso/callback", () => {
  const admin = adminClient();
  const fx = new Fixtures(admin);
  let existing: TempUser; // profile + auth user already linked (a returning employee)
  let newcomerProfileId: string; // profile only, no auth user yet (first SSO login)
  const newcomerEmail = `tmp-it-sso-new-${fx.tag}@sru-dev.internal`.toLowerCase();
  let newcomerAuthUserId: string | null = null;

  beforeAll(async () => {
    existing = await fx.user("sso-existing");
    const { data: p, error } = await admin.from("profiles").insert({ employee_number: `TMPIT-sso-new-${fx.tag}`, full_name_ar: "موظف جديد عبر الدخول الموحّد", email: newcomerEmail, status: "active", approval_status: "approved" }).select("id").single();
    if (error) throw error;
    newcomerProfileId = p.id;
  });

  afterAll(async () => {
    if (newcomerAuthUserId) await admin.auth.admin.deleteUser(newcomerAuthUserId);
    await admin.from("profiles").delete().eq("id", newcomerProfileId);
    await admin.from("sso_assertion_jti").delete().like("email", `tmp-it-sso-%${fx.tag}%`);
    await admin.from("audit_log").delete().in("action", ["sso_login_denied_no_profile"]).like("after_data->>email", `tmp-it-sso-%${fx.tag}%`);
    await fx.cleanup();
  });

  it("a valid assertion for a linked employee issues this app's session cookie", async () => {
    const res = await post(mint(existing.email));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; redirect: string };
    expect(body).toEqual({ ok: true, redirect: "/ar" });
    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies.some((c) => /sb-.*-auth-token/.test(c)), "session cookie").toBe(true);
  });

  it("the same assertion cannot be used twice", async () => {
    const token = mint(existing.email);
    expect((await post(token)).status).toBe(200);
    const replay = await post(token);
    expect(replay.status).toBe(403);
    expect((await replay.json()).error).toBe("replayed");
  });

  it("an assertion for another platform, or signed with an unknown kid, is refused", async () => {
    expect((await post(mint(existing.email, { aud: "majlis" }))).status).toBe(403);
    expect((await post(mint(existing.email, {}, "v99"))).status).toBe(403);
  });

  it("a university account with no HR profile is refused and audited", async () => {
    const stranger = `tmp-it-sso-stranger-${fx.tag}@sru-dev.internal`;
    const res = await post(mint(stranger));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("no_profile");
    const { data } = await admin.from("audit_log").select("id").eq("action", "sso_login_denied_no_profile").eq("after_data->>email", stranger);
    expect(data?.length).toBe(1);
  });

  it("first SSO login creates the auth account, links the profile, and grants the employee role", async () => {
    const res = await post(mint(newcomerEmail));
    expect(res.status).toBe(200);
    const { data: p } = await admin.from("profiles").select("auth_user_id").eq("id", newcomerProfileId).single();
    expect(p?.auth_user_id).toBeTruthy();
    newcomerAuthUserId = p!.auth_user_id as string;
    const { data: roles } = await admin.from("user_roles").select("role_id, scope_type, roles(role_code)").eq("user_id", newcomerAuthUserId);
    expect(roles?.length).toBe(1);
    expect((roles![0] as unknown as { roles: { role_code: string } }).roles.role_code).toBe("employee");
    expect(roles![0].scope_type).toBe("all");
  });
});
