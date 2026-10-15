import { isLocale } from "@/i18n/config";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "@/i18n/navigation";
import { TopBar } from "@/components/layout/TopBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { PrintBranding } from "@/components/PrintBranding";
import type { ProcessArea, VpraLevel } from "@/lib/vpra";

/**
 * Single, centralized auth gate for every page under (app)/ — added after
 * discovering live in production that /admin, /competencies, and
 * /org-units (built early, before real auth existed) had no login check at
 * all and were fully visible to unauthenticated visitors. Per-page checks
 * (employees, career-path, salary-scale, employees/new) are removed now
 * that this covers all of them uniformly — one place to protect a new page
 * under (app)/, not something each page has to remember to add itself.
 */
export default async function AppShellLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const safeLocale = isLocale(locale) ? locale : "ar";

  const supabase = await createClient();
  // A refresh token that's gone stale (expired, or already invalidated by
  // src/proxy.ts's own refresh moments earlier in the same request) makes
  // this throw rather than return {user: null} — confirmed live in
  // production stderr ("AuthApiError: Invalid Refresh Token: Refresh Token
  // Not Found"). Uncaught, that crashes THIS layout's render with no
  // error.tsx above it to catch it (error.tsx only catches errors from what
  // a layout renders, never the layout segment itself) — a blank page with
  // no recovery, reported live on /employees/new (2026-08). Treated exactly
  // like "not signed in" instead: the real cause (a broken session) gets
  // the same graceful redirect to /login this gate already had.
  let user = null;
  try {
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    user = authUser;
  } catch {
    user = null;
  }

  if (!user) {
    redirect({ href: "/login", locale: safeLocale });
    return null;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name_ar, full_name_en, must_change_password")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  // Forced first-login password change (2026-07-25, see login/actions.ts) —
  // enforced here too, not just at the login redirect, so it can't be
  // bypassed by navigating straight to any (app)/ URL with an existing
  // session (e.g. a bookmarked link, or simply not logging out first).
  if (profile?.must_change_password) {
    redirect({ href: "/change-password", locale: safeLocale });
    return null;
  }

  const userName =
    (safeLocale === "ar" ? profile?.full_name_ar : profile?.full_name_en ?? profile?.full_name_ar) ??
    undefined;

  // get_my_permissions() (20260722000001) — same SECURITY DEFINER pattern as
  // get_my_role_codes(), since role_permissions/roles both require a
  // userManagement grant to read directly, which most roles (including
  // plain employee) don't hold.
  const { data: permissionRows } = await supabase.rpc("get_my_permissions");
  const permissions = Object.fromEntries(
    ((permissionRows ?? []) as { process_area: ProcessArea; vpra_level: VpraLevel }[]).map((row) => [
      row.process_area,
      row.vpra_level,
    ])
  ) as Partial<Record<ProcessArea, VpraLevel>>;

  // has_any_subordinates() (20260830000002) — the Employees sidebar tab's
  // narrower `employeeDataSubordinates` branch only counts when the caller
  // genuinely has at least one real report; otherwise it would just open to
  // nothing useful for them (2026-08-30 request).
  const { data: hasSubordinates } = await supabase.rpc("has_any_subordinates");

  // The caller's own notifications for the TopBar bell. `notifications_select`
  // (20260807000006) restricts this to the caller's own rows with no
  // oversight branch at all, so no filter is needed (or possible) here.
  // Capped at 20: the bell is a glance, not an archive.
  const { data: notifications } = await supabase
    .from("notifications")
    .select("id, message_ar, link_path, read_at, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <div className="sru-app-shell">
      {/* Mounted once here (not per-page) so every screen under (app)/ carries
          the same print letterhead automatically — 2026-08-30: "اعتمد
          النموذج المرفق للتصدير على بي دي اف في جميع شاشات التطبيق واجعلها
          موحدة". `position: fixed` (see globals.css) makes placement in the
          tree irrelevant to where it renders on the printed page. */}
      <PrintBranding />
      <TopBar locale={safeLocale} userName={userName} notifications={notifications ?? []} ssoEnabled={Boolean(process.env.NEXT_PUBLIC_SRU_SSO_APP_KEY)} />
      <div className="sru-app-body">
        <Sidebar permissions={permissions} hasSubordinates={hasSubordinates ?? false} />
        <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
