import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseAssertionSecrets, verifySsoAssertion } from "@/lib/ssoAssertion";
import { isLocale } from "@/i18n/config";

/**
 * University single sign-on, server side (2026-10-12).
 *
 * The browser signs in to the university identity project through
 * `https://dt.sr.edu.sa/sso/v1/sru-sso.js`, asks it for a 60-second
 * assertion addressed to THIS platform (`SRUSSO.assertion()`), and posts it
 * here. This handler is the trust boundary: it verifies the signature with
 * the per-platform secret the SSO operator placed in `SRU_SSO_ASSERTION_SECRETS`,
 * refuses replays by `jti`, maps the email to an existing HR profile, and then
 * issues THIS app's own Supabase session — exactly what the SSO contract asks
 * of a platform with its own database ("تتحقّق منه هناك وتُصدر جلستك").
 *
 * Decisions (stated, reversible):
 *  - Only employees who already have a `profiles` row (by email) may enter.
 *    HR owns the roster; SSO never creates employees. An unknown university
 *    account gets a clear "no profile" answer and an audit row.
 *  - The SSO role (viewer/editor/app_admin) is ignored. Authorization inside
 *    this app is VPRA via `user_roles`, as everywhere else. A first-time SSO
 *    user with no roles at all receives the `employee` role (scope all), the
 *    least-privilege default every staff member needs to see their own page.
 *  - The HR auth account is created on first SSO login (no password, email
 *    confirmed) so `link_profile_to_auth_user()` links it and promotes any
 *    pending role assignments — the same path invites and direct accounts use.
 *  - Nothing from the assertion but the email is stored. Names and
 *    departments come from HR's own records.
 */

const bodySchema = z.object({
  assertion: z.string().min(20).max(4096),
  locale: z.string().optional(),
  /**
   * The directory fields the SSO library hands the browser (ensure_app_access:
   * nameAr / department / positionAr). NOT signed, so never used for identity
   * or authorization — only as hints on a profile that HR must approve before
   * it can log in. The signed `name` claim from the assertion takes precedence.
   */
  directory: z
    .object({
      nameAr: z.string().trim().max(200).nullish(),
      department: z.string().trim().max(200).nullish(),
      positionAr: z.string().trim().max(200).nullish(),
    })
    .optional(),
});

type Denial = "sso_disabled" | "invalid_assertion" | "replayed" | "no_profile" | "profile_pending" | "inactive" | "rate_limited" | "unknown";

/** A visibly provisional employee number HR replaces when approving (profiles.employee_number is NOT NULL UNIQUE). */
function provisionalEmployeeNumber(): string {
  return `SSO-${Date.now().toString(36).toUpperCase()}`;
}

function deny(error: Denial, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: NextRequest) {
  const appKey = process.env.NEXT_PUBLIC_SRU_SSO_APP_KEY;
  const secrets = parseAssertionSecrets(process.env.SRU_SSO_ASSERTION_SECRETS);
  if (!appKey || Object.keys(secrets).length === 0) return deny("sso_disabled", 503);

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!(await checkRateLimit(`sso_callback:ip:${ip}`, 30, 15 * 60))) return deny("rate_limited", 429);

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return deny("invalid_assertion", 400);
  const locale = parsed.data.locale && isLocale(parsed.data.locale) ? parsed.data.locale : "ar";

  const verified = verifySsoAssertion(parsed.data.assertion, { appKey, secrets });
  if (!verified.ok) return deny("invalid_assertion", 403);
  const { claims, kid } = verified;

  const admin = createAdminClient();

  // Replay guard: the jti is the primary key, so a second use fails on 23505.
  const { error: jtiError } = await admin
    .from("sso_assertion_jti")
    .insert({ jti: claims.jti, email: claims.email, expires_at: new Date(claims.exp * 1000).toISOString() });
  if (jtiError) {
    if (jtiError.code === "23505") return deny("replayed", 403);
    return deny("unknown", 500);
  }
  // Opportunistic housekeeping; failure here is harmless.
  await admin.from("sso_assertion_jti").delete().lt("expires_at", new Date(Date.now() - 5 * 60_000).toISOString());

  const { data: profile } = await admin
    .from("profiles")
    .select("id, auth_user_id, status, approval_status")
    .eq("email", claims.email)
    .is("deleted_at", null)
    .maybeSingle();

  if (!profile) {
    // A university account with no HR profile yet (decided 2026-10-15): create
    // the profile from what SSO knows, PENDING HR approval, and tell the user
    // so. The signed name wins; department/position are matched by exact name
    // against this platform's own org units and job titles, otherwise left
    // empty for HR to fill in. The raw hints go to the audit row either way.
    const hints = parsed.data.directory ?? {};
    const displayName = (claims.name ?? hints.nameAr ?? "").trim() || claims.email.split("@")[0];
    const [{ data: unit }, { data: titles }] = await Promise.all([
      hints.department ? admin.from("org_units").select("id").eq("name_ar", hints.department).is("deleted_at", null).limit(2) : Promise.resolve({ data: [] as { id: string }[] }),
      hints.positionAr ? admin.from("job_titles").select("id").eq("name_ar", hints.positionAr).is("deleted_at", null).limit(2) : Promise.resolve({ data: [] as { id: string }[] }),
    ]);
    const orgUnitId = unit && unit.length === 1 ? unit[0].id : null;
    const jobTitleId = titles && titles.length === 1 ? titles[0].id : null;
    const { data: created, error: createProfileError } = await admin
      .from("profiles")
      .insert({
        employee_number: provisionalEmployeeNumber(),
        full_name_ar: displayName,
        email: claims.email,
        org_unit_id: orgUnitId,
        job_title_id: jobTitleId,
        status: "active",
        approval_status: "pending",
      })
      .select("id")
      .single();
    if (createProfileError || !created) {
      await admin.from("audit_log").insert({ action: "sso_login_denied_no_profile", entity: "auth", after_data: { email: claims.email, kid, create_error: createProfileError?.code ?? null } });
      return deny("no_profile", 403);
    }
    await admin.from("audit_log").insert({
      action: "sso_profile_created_pending",
      entity: "profiles",
      entity_id: created.id,
      after_data: { email: claims.email, name: displayName, sso_department: hints.department ?? null, sso_position: hints.positionAr ?? null, matched_org_unit: orgUnitId, matched_job_title: jobTitleId },
    });
    return deny("profile_pending", 403);
  }
  if (profile.approval_status === "pending") {
    // Created on an earlier visit (or by HR) and still awaiting approval.
    return deny("profile_pending", 403);
  }
  if (profile.status !== "active" || profile.approval_status !== "approved") {
    await admin.from("audit_log").insert({ action: "sso_login_denied_inactive", entity: "profiles", entity_id: profile.id, after_data: { status: profile.status, approval_status: profile.approval_status } });
    return deny("inactive", 403);
  }

  // First SSO login: create the HR auth account; the existing trigger links the
  // profile and promotes pending_role_assignments.
  let authUserId: string | null = profile.auth_user_id;
  if (!authUserId) {
    const { error: createError } = await admin.auth.admin.createUser({
      email: claims.email,
      email_confirm: true,
      user_metadata: { created_via: "sru_sso" },
    });
    if (createError) return deny("unknown", 500);
    const { data: linked } = await admin.from("profiles").select("auth_user_id").eq("id", profile.id).single();
    authUserId = linked?.auth_user_id ?? null;
    if (!authUserId) return deny("unknown", 500);
    await admin.from("audit_log").insert({ actor_id: authUserId, action: "sso_account_created", entity: "profiles", entity_id: profile.id });
  }

  // Least-privilege default for a staff member with no role yet.
  const { count: roleCount } = await admin.from("user_roles").select("id", { count: "exact", head: true }).eq("user_id", authUserId);
  if ((roleCount ?? 0) === 0) {
    const { data: employeeRole } = await admin.from("roles").select("id").eq("role_code", "employee").is("deleted_at", null).maybeSingle();
    if (employeeRole) {
      await admin.from("user_roles").insert({ user_id: authUserId, role_id: employeeRole.id, scope_type: "all" });
      await admin.from("audit_log").insert({ actor_id: authUserId, action: "sso_default_role_assigned", entity: "user_roles", after_data: { role_code: "employee", scope_type: "all" } });
    }
  }

  // Issue THIS app's session: a one-time magic-link token minted server-side
  // and consumed immediately by the cookie-backed server client, so the user
  // never sees a link and no email is sent.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: claims.email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) return deny("unknown", 500);

  const supabase = await createClient();
  const { error: sessionError } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (sessionError) return deny("unknown", 500);

  await admin.from("audit_log").insert({ actor_id: authUserId, action: "login", entity: "auth", after_data: { method: "sso", kid } });

  return NextResponse.json({ ok: true, redirect: `/${locale}` });
}
