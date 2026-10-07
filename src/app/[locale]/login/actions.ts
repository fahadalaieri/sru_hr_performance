"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { redirect } from "@/i18n/navigation";
import type { Locale } from "@/i18n/config";

const credentialsSchema = z.object({
  identifier: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1),
});

export type LoginState = { error: "invalid_input" | "invalid_credentials" | "rate_limited" } | null;

/**
 * Server Action for the login form. `locale` is bound client-side
 * (`login.bind(null, locale)`) so the post-login redirect keeps the
 * current locale prefix. Auth failures resolve to one generic
 * "invalid_credentials" state regardless of whether the email or the
 * password was wrong, to avoid leaking which part of the pair was
 * incorrect (standard practice — CLAUDE.md §5's least-privilege spirit
 * applies to error messages too, not just data access).
 *
 * Rate limited two ways (CLAUDE.md §5-A) before ever calling Supabase Auth:
 * per identifier (5/15min — the direct brute-force-one-account defense) and
 * per client IP (20/15min — looser, since a shared NAT/proxy IP can carry
 * many legitimate users; catches credential-stuffing across many identifiers
 * from one source). `x-forwarded-for` is best-effort and trusts the
 * deployment's own proxy/CDN to set it honestly — falls back to a constant
 * bucket if absent (e.g. local dev), which degrades to "one shared IP bucket
 * for everyone" rather than no protection at all.
 *
 * 2026-07-25: "اضف اسم المستخدم واجعله خيارا عند الدخول اما الايميل او اسم
 * المستخدم" — the single `identifier` field accepts either. Supabase Auth
 * itself only ever authenticates by email, so `resolve_login_identifier()`
 * resolves a username to its real email first; an already-email-shaped
 * identifier passes through unchanged. Since 20261007000001 that RPC is
 * callable by service_role ONLY: while it was granted to anon, any visitor
 * could call it straight through PostgREST with the public anon key and
 * enumerate usernames / read their emails, bypassing the rate limit that
 * lives in THIS action, not in the function. Calling it through the admin
 * client here keeps username login working and closes that public path.
 * Resolution failure (no such
 * username) falls through to the exact same generic "invalid_credentials"
 * response signInWithPassword itself would give for a wrong password —
 * this reveals nothing about whether the identifier exists that a normal
 * failed login wouldn't already.
 */
export async function login(
  locale: Locale,
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const parsed = credentialsSchema.safeParse({
    identifier: formData.get("identifier"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "invalid_input" };
  }

  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  const [identifierOk, ipOk] = await Promise.all([
    checkRateLimit(`login:identifier:${parsed.data.identifier}`, 5, 15 * 60),
    checkRateLimit(`login:ip:${ip}`, 20, 15 * 60),
  ]);

  if (!identifierOk || !ipOk) {
    return { error: "rate_limited" };
  }

  const supabase = await createClient();
  const admin = createAdminClient();

  // Service-role call (see the header comment): runs only after the rate
  // limit above has passed, and the result never leaves this action.
  const { data: resolvedEmail } = await admin.rpc("resolve_login_identifier", {
    p_identifier: parsed.data.identifier,
  });

  if (!resolvedEmail) {
    return { error: "invalid_credentials" };
  }

  const { data: signInData, error } = await supabase.auth.signInWithPassword({
    email: resolvedEmail,
    password: parsed.data.password,
  });

  if (error) {
    return { error: "invalid_credentials" };
  }

  // Real feedback (2026-07-25): CLAUDE.md §5-A rule 5.1 has always required
  // audit_log to capture logins, but nothing in this codebase ever wrote one
  // -- confirmed via a direct search before building the "أنشطة المستخدمين"
  // admin tab that needs this data. A failed audit write must never block a
  // legitimate login, so its result is deliberately not checked here. Logged
  // unconditionally, before the must_change_password branch below — a login
  // is a login regardless of what happens right after it.
  await admin.from("audit_log").insert({ actor_id: signInData.user.id, action: "login", entity: "auth" });

  // 2026-07-25: accounts created directly (no invite email — see
  // employees/new/actions.ts's mode='direct') carry an admin-set or
  // system-suggested password and must be forced to pick their own before
  // reaching the app, entirely in-app, with no recovery-email round trip
  // ("يطلب منه ادخال رقم سري جديد بدون الرجوع للبريد الالكتروني"). Checked
  // via the caller's own RLS-respecting client — profiles_select's self-row
  // bypass already allows this regardless of any employeeData grant.
  const { data: profile } = await supabase
    .from("profiles")
    .select("must_change_password")
    .eq("auth_user_id", signInData.user.id)
    .maybeSingle();

  if (profile?.must_change_password) {
    return redirect({ href: "/change-password", locale });
  }

  return redirect({ href: "/", locale });
}
