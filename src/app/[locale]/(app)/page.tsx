import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import {
  CalendarRange,
  CheckCircle2,
  ClipboardCheck,
  FileSignature,
  GraduationCap,
  ListTodo,
  UserRoundCheck,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Link } from "@/i18n/navigation";
import { getDisplayTimezone } from "@/lib/systemSettings";
import { formatDateDmy } from "@/lib/dateParts";
import {
  canAdvanceEvaluationState,
  evaluationStateLabels,
  hasVpraAccess,
  type EvaluationState,
  type ProcessArea,
  type RoleCode,
  type VpraLevel,
} from "@/lib/vpra";
import { availableRequestTransitions } from "@/lib/recruitmentWorkflow";
import { isLocale, type Locale } from "@/i18n/config";
import { ProfileTabs, type ProfileTab } from "@/components/ProfileTabs";
import { buildEmployeeSelfTabs } from "@/app/[locale]/(app)/employee-self-sections";

/**
 * The home page answers one question: what needs me today.
 *
 * That is deliberately NOT what /reports answers. Reports is the numbers —
 * completion rates, headcount, staffing coverage. This is the worklist: the
 * things that stay stuck until this particular person acts, and the work that
 * is already theirs. It replaces a splash screen that showed the product's
 * name and nothing else.
 *
 * Every row is a real query against a table this caller can already read, and
 * every row is gated on the same process area and level that governs the
 * action it links to — so a queue only appears when the caller could actually
 * clear it. Nothing here is estimated: a number that cannot be derived from
 * real rows is an absent row, not a guess.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : "ar";
  const t = await getTranslations("HomePage");
  const supabase = await createClient();
  const digits = locale === "ar" ? "ar-SA-u-nu-latn" : "en-US";

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // `user` can be null on a prefetch that outruns the layout's redirect —
  // the same race already handled on /reports and /profile.
  const { data: myProfile } = user
    ? await supabase
        .from("profiles")
        .select("id, full_name_ar, full_name_en, job_titles(name_ar), org_units(name_ar)")
        .eq("auth_user_id", user.id)
        .maybeSingle()
    : { data: null };

  const profile = myProfile as unknown as {
    id: string;
    full_name_ar: string;
    full_name_en: string | null;
    job_titles: { name_ar: string } | null;
    org_units: { name_ar: string } | null;
  } | null;

  const [{ data: permissionRows }, { data: roleCodeRows }, timezone] = await Promise.all([
    supabase.rpc("get_my_permissions"),
    supabase.rpc("get_my_role_codes"),
    getDisplayTimezone(supabase),
  ]);

  const permissions = Object.fromEntries(
    ((permissionRows ?? []) as { process_area: ProcessArea; vpra_level: VpraLevel }[]).map((r) => [
      r.process_area,
      r.vpra_level,
    ])
  ) as Partial<Record<ProcessArea, VpraLevel>>;
  const has = (area: ProcessArea, min: VpraLevel = "view") =>
    hasVpraAccess(permissions[area] ?? "none", min);

  // get_my_role_codes() returns a plain array of codes, not rows with a
  // role_code column — reading it as objects yields [undefined] and every
  // canAdvanceEvaluationState() check below then silently answers "no".
  // Caught live: a real draft evaluation failed to raise its queue row.
  const myRoles = (roleCodeRows ?? []) as RoleCode[];

  // "Today" in the configured display timezone, as YYYY-MM-DD — the same
  // string shape the date columns hold, so the comparison never goes through
  // a Date and never shifts a calendar day.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

  // ---- the cycle everything else is measured against ---------------------
  const { data: cycleRows } = await supabase
    .from("evaluation_cycles")
    .select("name_ar, start_date, end_date")
    .is("deleted_at", null)
    .lte("start_date", today)
    .gte("end_date", today)
    .order("start_date", { ascending: false })
    .limit(1);
  const activeCycle = (cycleRows ?? [])[0] as
    | { name_ar: string; start_date: string; end_date: string }
    | undefined;

  // ---- my own work -------------------------------------------------------
  // Filtered to my own profile id explicitly rather than left to each table's
  // broader RLS branches: an approve-level reader would otherwise see the
  // whole organisation's rows counted as "mine". Same discipline as
  // /evaluations/mine and /profile.
  const mine = profile
    ? await Promise.all([
        supabase
          .from("evaluations")
          .select("id, state")
          .eq("employee_id", profile.id)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(1),
        supabase
          .from("bau_tasks")
          .select("id", { count: "exact", head: true })
          .eq("employee_id", profile.id)
          .is("deleted_at", null),
      ])
    : null;

  const myEvaluation = (mine?.[0].data ?? [])[0] as { id: string; state: EvaluationState } | undefined;
  const myTasks = mine?.[1].count ?? 0;

  // ---- the queue ---------------------------------------------------------
  const queue: Array<{ key: string; count: number; href: string; icon: ReactNode }> = [];

  // Unread notifications are deliberately NOT a row here. There is no
  // /notifications route — they live in the top bar's bell, which already
  // carries its own unread badge. The row that used to be here linked to a
  // page that does not exist, and said a second time what the bell says.

  // Evaluations I can advance right now — visible to me AND actionable at
  // their exact state by one of my real roles. The same rule /evaluations/
  // review applies, so the two screens can never disagree about what is
  // waiting.
  if (profile) {
    const { data: visible } = await supabase
      .from("evaluations")
      .select("id, state")
      .neq("employee_id", profile.id)
      .is("deleted_at", null);
    const actionable = ((visible ?? []) as { id: string; state: EvaluationState }[]).filter((row) =>
      myRoles.some((role) => canAdvanceEvaluationState(row.state, role))
    );
    if (actionable.length > 0) {
      queue.push({
        key: "evaluationsToReview",
        count: actionable.length,
        href: "/evaluations/review",
        icon: <ClipboardCheck size={15} aria-hidden />,
      });
    }
  }

  // My own evaluation, when the ball is in my court.
  if (myEvaluation && myRoles.some((role) => canAdvanceEvaluationState(myEvaluation.state, role))) {
    queue.push({
      key: "myEvaluation",
      count: 1,
      href: `/evaluations/${myEvaluation.id}`,
      icon: <GraduationCap size={15} aria-hidden />,
    });
  }

  // Employees waiting on an approval only an approve-level holder can give.
  if (has("employeeData", "approve")) {
    const { count } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("approval_status", "pending")
      .is("deleted_at", null);
    if ((count ?? 0) > 0) {
      queue.push({
        key: "employeeApprovals",
        count: count ?? 0,
        href: "/employees",
        icon: <UserRoundCheck size={15} aria-hidden />,
      });
    }
  }

  // Promotions, rewards and recommendations all sit behind the `promotions`
  // area at 'recommend' — the same bar their own review actions enforce.
  if (has("promotions", "recommend")) {
    const [{ count: promotions }, { count: rewards }, { count: recommendations }] = await Promise.all([
      supabase.from("promotions").select("id", { count: "exact", head: true }).eq("status", "pending").is("deleted_at", null),
      supabase.from("rewards").select("id", { count: "exact", head: true }).eq("status", "pending").is("deleted_at", null),
      supabase.from("recommendations").select("id", { count: "exact", head: true }).eq("status", "pending").is("deleted_at", null),
    ]);
    if ((promotions ?? 0) > 0) {
      queue.push({ key: "promotions", count: promotions ?? 0, href: "/promotions", icon: <FileSignature size={15} aria-hidden /> });
    }
    if ((rewards ?? 0) > 0) {
      queue.push({ key: "rewards", count: rewards ?? 0, href: "/rewards", icon: <FileSignature size={15} aria-hidden /> });
    }
    if ((recommendations ?? 0) > 0) {
      queue.push({
        key: "recommendations",
        count: recommendations ?? 0,
        href: "/recommendations",
        icon: <FileSignature size={15} aria-hidden />,
      });
    }
  }

  // Recruitment requests waiting on a step this caller may take, asked of the
  // same transition table the request screen itself obeys — so "needs you"
  // here means exactly what it means there.
  if (has("recruitmentPlan") || has("recruitmentBudget")) {
    const { data: requests } = await supabase
      .from("recruitment_requests")
      .select("id, status")
      .is("deleted_at", null);
    const actionable = ((requests ?? []) as { id: string; status: string }[]).filter(
      (row) => availableRequestTransitions(row.status, permissions).length > 0
    );
    if (actionable.length > 0) {
      queue.push({
        key: "recruitmentRequests",
        count: actionable.length,
        href: "/recruitment/requests",
        icon: <ListTodo size={15} aria-hidden />,
      });
    }
  }

  const displayName = locale === "en" && profile?.full_name_en ? profile.full_name_en : profile?.full_name_ar;
  const roleLine = [profile?.job_titles?.name_ar, profile?.org_units?.name_ar].filter(Boolean).join(" — ");

  // Everything an employee has about their own work now lives here beside the
  // worklist (2026-08-25), instead of behind the profile page. "work" gates the
  // queries too, so the details tab this page does not show costs nothing.
  const workTabs = await buildEmployeeSelfTabs("work");

  const dashboard = (
    <>
      <p className="sru-home-cycle" style={{ marginBottom: 18 }}>
        <CalendarRange size={14} aria-hidden />
        {activeCycle
          ? t("cycleActive", { name: activeCycle.name_ar, end: formatDateDmy(activeCycle.end_date, locale) })
          : t("cycleNone")}
      </p>

      <section className="sru-home-section">
        <h2>{t("queueHeading")}</h2>
        <p className="sru-home-note">{t("queueNote")}</p>
        {queue.length === 0 ? (
          <p className="sru-home-clear">
            <CheckCircle2 size={16} aria-hidden />
            {t("queueClear")}
          </p>
        ) : (
          <ul className="sru-home-queue">
            {queue.map((row) => (
              <li key={row.key}>
                <Link href={row.href}>
                  <span className="sru-home-queue-count">{row.count.toLocaleString(digits)}</span>
                  <span className="sru-home-queue-label">
                    {row.icon}
                    {t(`queue_${row.key}`)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sru-home-section">
        <h2>{t("mineHeading")}</h2>
        <div className="sru-home-mine">
          <Link href={myEvaluation ? `/evaluations/${myEvaluation.id}` : "/evaluations/mine"} className="sru-home-tile">
            <span className="sru-home-tile-label">
              <GraduationCap size={14} aria-hidden />
              {t("mineEvaluation")}
            </span>
            <strong>{myEvaluation ? evaluationStateLabels[myEvaluation.state] : t("mineEvaluationNone")}</strong>
          </Link>
          <span className="sru-home-tile">
            <span className="sru-home-tile-label">
              <ListTodo size={14} aria-hidden />
              {t("mineTasks")}
            </span>
            <strong>{myTasks.toLocaleString(digits)}</strong>
          </span>
        </div>
      </section>
    </>
  );

  const tabs: ProfileTab[] = [{ id: "my-board", label: t("boardTab"), content: dashboard }, ...workTabs];

  return (
    <div className="sru-home">
      <header className="sru-home-head">
        <p className="sru-home-eyebrow">{t("eyebrow")}</p>
        <h1>{displayName ? t("greetingNamed", { name: displayName }) : t("greeting")}</h1>
        <p className="sru-home-role">{roleLine || t("noRoleYet")}</p>
      </header>
      <ProfileTabs tabs={tabs} />
    </div>
  );
}
