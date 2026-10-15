import { getLocale, getTranslations } from "next-intl/server";
import { formatDateDmy } from "@/lib/dateParts";
import { createClient } from "@/lib/supabase/server";
import {
  pillars,
  getCompetenciesByPillar,
  behavioralLevelLabels,
  type BehavioralLevel,
} from "@/lib/data/competencies";
import { evalTypeLabels, evaluationStateLabels, type EvalType, type EvaluationState } from "@/lib/vpra";
import { type ProfileTab } from "@/components/ProfileTabs";
import { MyCertificatesEditor } from "@/components/MyCertificatesEditor";
import { type CareerJobTitleInfo } from "@/lib/careerPathTree";
import { getSelfScopedCareerTree } from "@/lib/careerPathData";
import { CareerPathForwardTree } from "@/components/CareerPathForwardTree";
import { ActualValueField } from "@/components/ActualValueField";
import { recordEmployeeActual } from "@/app/[locale]/(app)/operational-plans/[id]/actions";

/**
 * The sections an employee sees about themselves.
 *
 * These were all tabs on /profile until 2026-08-25, when the project owner
 * asked for the split that is now in force: /profile holds who you are (and
 * changing your password), while everything about your WORK — targets,
 * competencies, tasks, performance, career path — moved to the home page,
 * beside the worklist. They are built here, once, so the two screens cannot
 * drift into showing the same thing differently.
 *
 * `mode` decides which half is built, and it gates the QUERIES, not just the
 * output: asking for "data" must not pay for the target/competency/career
 * fetches that only the work tabs render.
 */
export type EmployeeSectionsMode = "data" | "work";

export async function buildEmployeeSelfTabs(mode: EmployeeSectionsMode): Promise<ProfileTab[]> {
  const wantsWork = mode === "work";
  const t = await getTranslations("MyProfilePage");
  const locale = await getLocale();
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // `user` can be null here even though (app)/layout.tsx's own getUser() call
  // already gated this route -- the exact same class of crash already found
  // and fixed on /reports for a background/prefetch request that reached the
  // page before the layout's redirect took effect. Treat it the same as "no
  // linked profile" (the existing `!p` branch below) rather than crash on
  // `user!.id`.
  //
  // Self-row is always visible on profiles regardless of VPRA (profiles_select).
  // org_units/job_titles embeds work too: employee holds careerPath=view, and
  // both tables' SELECT policies accept careerPath as one of their OR-branches.
  const { data: profile } = user
    ? await supabase
        .from("profiles")
        .select(
          "id, employee_number, full_name_ar, full_name_en, email, hire_date, status, job_title_id, supervisor_id, qualification, education_speciality, mobile, certificates, job_title_hint, org_units(name_ar), job_titles(name_ar, grade_level)"
        )
        .eq("auth_user_id", user.id)
        .maybeSingle()
    : { data: null };

  const p = profile as unknown as
    | {
        id: string;
        employee_number: string;
        full_name_ar: string;
        full_name_en: string | null;
        email: string;
        hire_date: string | null;
        status: string;
        job_title_id: string | null;
        supervisor_id: string | null;
        qualification: string | null;
        education_speciality: string | null;
        mobile: string | null;
        certificates: string | null;
        job_title_hint: string | null;
        org_units: { name_ar: string } | null;
        job_titles: { name_ar: string; grade_level: number } | null;
      }
    | null;

  // get_my_supervisor() (20260722000002) — profiles_select's RLS has no
  // branch letting a plain employee (no employeeData grant) read an
  // arbitrary colleague's row, including their own supervisor's; confirmed
  // this returns null via a direct query before adding the RPC. Same
  // SECURITY DEFINER self-lookup pattern as get_my_role_codes()/
  // get_my_permissions().
  const { data: supervisorRows } = p?.supervisor_id ? await supabase.rpc("get_my_supervisor") : { data: null };
  const supervisor = (supervisorRows?.[0] as { full_name_ar: string; full_name_en: string | null } | undefined) ?? null;

  // Deliberately filtered to `employee_id = my own profile id`, same
  // discipline as /evaluations/mine — goals_select's RLS would also let
  // broader roles (org-unit scoped goalAssignment=prepare, direct
  // supervisors) see this data, which is wrong for a "my own goals" view.
  const { data: goalsData } = wantsWork && p
    ? await supabase
        .from("goals")
        .select("id, custom_title_ar, weight, target_ar, status, goal_library(title_ar), evaluation_cycles(name_ar)")
        .eq("employee_id", p.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
    : { data: null };

  const goals = goalsData as unknown as Array<{
    id: string;
    custom_title_ar: string | null;
    weight: number | null;
    target_ar: string | null;
    status: string;
    goal_library: { title_ar: string } | null;
    evaluation_cycles: { name_ar: string } | null;
  }> | null;

  // Same self-scoping discipline as goals above — bau_tasks_select's RLS
  // has broader OR-branches (org-unit approve, direct supervisor) that would
  // leak into a "my own tasks" view if not explicitly filtered here too.
  const { data: tasksData } = wantsWork && p
    ? await supabase
        .from("bau_tasks")
        .select("id, title_ar, weight, status, evaluation_cycles(name_ar)")
        .eq("employee_id", p.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
    : { data: null };

  // The competencies my direct manager actually set for me
  // (employee_competencies, 20260827000003). Self-scoped explicitly even
  // though that table's SELECT policy already has a self-row branch — the
  // same discipline as goals and tasks above, so a manager viewing their own
  // home page never sees a report's rows here.
  const { data: myCompetencyData } = wantsWork && p
    ? await supabase
        .from("employee_competencies")
        .select("id, required_level, competencies(name_ar, type)")
        .eq("employee_id", p.id)
        .is("deleted_at", null)
    : { data: null };

  const myCompetencies = (myCompetencyData ?? []) as unknown as Array<{
    id: string;
    required_level: BehavioralLevel;
    competencies: { name_ar: string; type: string } | null;
  }>;

  const tasks = tasksData as unknown as Array<{
    id: string;
    title_ar: string;
    weight: number | null;
    status: string;
    evaluation_cycles: { name_ar: string } | null;
  }> | null;

  // career_path_select's RLS (check_vpra('careerPath','view')) already lets
  // employee read the whole table -- getSelfScopedCareerTree fetches it in
  // full (small table, ~150-200 rows) and walks it forward in TS via
  // buildForwardCareerTree, rather than a new recursive SQL function,
  // matching this app's established preference for assembling small
  // structures client/server side (OrgChartTree, /reports) over new SQL
  // complexity. Narrowed to exactly the job titles reachable from this
  // employee's own job title -- "his upcoming path only", per the project
  // owner's explicit instruction -- not the full company matrix. Shared
  // with /career-path's own view-only branch (2026-07-26) so both render
  // identically instead of duplicating this fetch+walk logic.
  const { tree: careerTree, jobTitleInfo: careerJobTitleInfo } = wantsWork && p?.job_title_id
    ? await getSelfScopedCareerTree(supabase, p.job_title_id)
    : { tree: null, jobTitleInfo: new Map<string, CareerJobTitleInfo>() };

  // "My Performance Level" — an early, explicitly-flagged-as-interim
  // dashboard (2026-07-22): the project owner asked for a performance
  // level view but hadn't specified its exact shape yet, so this combines
  // two tables that already grant a self-row SELECT bypass — evaluations'
  // own scores (evaluation_scores) and any calibration_results — rather
  // than inventing new schema for it.
  const { data: evaluationsData } = wantsWork && p
    ? await supabase
        .from("evaluations")
        .select("id, eval_type, state, evaluation_cycles(name_ar)")
        .eq("employee_id", p.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
    : { data: null };

  const evaluationsList = evaluationsData as unknown as Array<{
    id: string;
    eval_type: string;
    state: string;
    evaluation_cycles: { name_ar: string } | null;
  }> | null;

  const evaluationIds = evaluationsList?.map((e) => e.id) ?? [];
  const { data: scoresData } =
    evaluationIds.length > 0
      ? await supabase.from("evaluation_scores").select("evaluation_id, score").in("evaluation_id", evaluationIds).is("deleted_at", null)
      : { data: null };

  const scoresByEvaluation = new Map<string, number[]>();
  for (const row of (scoresData ?? []) as Array<{ evaluation_id: string; score: number | null }>) {
    if (row.score == null) continue;
    const list = scoresByEvaluation.get(row.evaluation_id) ?? [];
    list.push(row.score);
    scoresByEvaluation.set(row.evaluation_id, list);
  }

  const { data: calibrationData } = wantsWork && p
    ? await supabase
        .from("calibration_results")
        .select("id, original_rating, calibrated_rating, justification, calibration_sessions(evaluation_cycles(name_ar))")
        .eq("employee_id", p.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
    : { data: null };

  const calibrationResults = calibrationData as unknown as Array<{
    id: string;
    original_rating: number | null;
    calibrated_rating: number | null;
    justification: string | null;
    calibration_sessions: { evaluation_cycles: { name_ar: string } | null } | null;
  }> | null;

  // One certificate per line (20260821000001).
  const certificates = (p?.certificates ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // ---- مستهدفاتي من الخطة التنفيذية (2026-08-23) ----
  const { data: myTargetShareRows } = wantsWork && p?.id
    ? await supabase
        .from("operational_plan_target_employees")
        .select("id, percentage, target_org_unit_id, actual_value")
        .eq("employee_id", p.id)
        .is("deleted_at", null)
    : { data: [] };
  const myTargetShares = (myTargetShareRows ?? []) as Array<{
    id: string;
    percentage: number | string;
    target_org_unit_id: string;
    actual_value: number | string | null;
  }>;

  const { data: myUnitShareRows } =
    myTargetShares.length > 0
      ? await supabase
          .from("operational_plan_target_org_units")
          .select("id, executive_plan_target_id, org_unit_id, percentage")
          .in(
            "id",
            myTargetShares.map((r) => r.target_org_unit_id)
          )
          .is("deleted_at", null)
      : { data: [] };
  const myUnitShares = (myUnitShareRows ?? []) as Array<{
    id: string;
    executive_plan_target_id: string;
    org_unit_id: string;
    percentage: number | string;
  }>;

  const { data: myPlanTargetRows } =
    myUnitShares.length > 0
      ? await supabase
          .from("operational_plan_targets")
          .select("id, executive_plan_id, strategic_kpi_id, target_value")
          .in(
            "id",
            myUnitShares.map((r) => r.executive_plan_target_id)
          )
          .is("deleted_at", null)
      : { data: [] };
  const myPlanTargets = (myPlanTargetRows ?? []) as Array<{
    id: string;
    executive_plan_id: string;
    strategic_kpi_id: string;
    target_value: number | string | null;
  }>;

  const { data: myKpiRows } =
    myPlanTargets.length > 0
      ? await supabase
          .from("strategic_kpis")
          .select("id, title_ar, unit_ar")
          .in(
            "id",
            myPlanTargets.map((r) => r.strategic_kpi_id)
          )
      : { data: [] };
  const myKpiById = new Map(
    ((myKpiRows ?? []) as Array<{ id: string; title_ar: string; unit_ar: string }>).map((k) => [k.id, k])
  );

  const { data: myPlanRows } =
    myPlanTargets.length > 0
      ? await supabase
          .from("operational_plans")
          .select("id, name_ar")
          .in(
            "id",
            myPlanTargets.map((r) => r.executive_plan_id)
          )
      : { data: [] };
  const myPlanNameById = new Map(((myPlanRows ?? []) as Array<{ id: string; name_ar: string }>).map((pl) => [pl.id, pl.name_ar]));

  const { data: myShareUnitRows } =
    myUnitShares.length > 0
      ? await supabase
          .from("org_units")
          .select("id, name_ar")
          .in(
            "id",
            myUnitShares.map((r) => r.org_unit_id)
          )
      : { data: [] };
  const myUnitNameById = new Map(((myShareUnitRows ?? []) as Array<{ id: string; name_ar: string }>).map((u) => [u.id, u.name_ar]));

  const myTargets = myTargetShares.map((mine) => {
    const unitShare = myUnitShares.find((u) => u.id === mine.target_org_unit_id);
    const planTarget = unitShare ? myPlanTargets.find((pt) => pt.id === unitShare.executive_plan_target_id) : undefined;
    const kpi = planTarget ? myKpiById.get(planTarget.strategic_kpi_id) : undefined;
    const yearValue = planTarget?.target_value == null ? null : Number(planTarget.target_value);
    const unitPercent = unitShare == null ? 0 : Number(unitShare.percentage);
    const myPercent = Number(mine.percentage);
    // My share of the target's own value: the unit's cut of it, then mine of
    // the unit's. Rounded for display only — nothing is stored.
    const myValue = yearValue == null ? null : Math.round(((yearValue * unitPercent * myPercent) / 10000) * 100) / 100;
    return {
      id: mine.id,
      title: kpi?.title_ar ?? "—",
      unit: kpi?.unit_ar ?? "",
      planName: planTarget ? myPlanNameById.get(planTarget.executive_plan_id) ?? "—" : "—",
      orgUnitName: unitShare ? myUnitNameById.get(unitShare.org_unit_id) ?? "—" : "—",
      myPercent,
      actualValue: mine.actual_value,
      // Of the whole target, not of the unit's share — the number that
      // actually says how much of it is mine.
      overallPercent: Math.round(((unitPercent * myPercent) / 100) * 100) / 100,
      myValue,
    };
  });

  const tabs: ProfileTab[] = !p
    ? []
    : [
        {
          id: "my-data",
          label: t("infoTitle"),
          content: (
            <div className="sru-profile-info">
              {/* A person, then their facts: the identity band carries the
                  name and the three things that place them, and the rest is
                  grouped so the eye is not asked to scan ten equal boxes. */}
              <div className="sru-profile-identity">
                <span className="sru-profile-avatar" aria-hidden>
                  {p.full_name_ar.trim().charAt(0)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <h2 className="sru-profile-name">{p.full_name_ar}</h2>
                  {p.full_name_en && (
                    <p className="sru-name-en">
                      {p.full_name_en}
                    </p>
                  )}
                  <div className="sru-profile-badges">
                    <span className="sru-chip sru-en">{p.employee_number}</span>
                    {p.job_titles?.name_ar && (
                      <span className="sru-chip">
                        {p.job_titles.name_ar}
                        <span className="sru-en" style={{ marginInlineStart: 6, opacity: 0.75 }}>
                          {t("gradeLabel", { grade: p.job_titles.grade_level })}
                        </span>
                      </span>
                    )}
                    {p.org_units?.name_ar && <span className="sru-chip">{p.org_units.name_ar}</span>}
                  </div>
                </div>
              </div>

              <div className="sru-profile-groups">
                <section className="sru-profile-group">
                  <h3>{t("contactGroup")}</h3>
                  <dl>
                    <dt>{t("emailLabel")}</dt>
                    <dd dir="ltr">{p.email}</dd>
                    <dt>{t("mobileLabel")}</dt>
                    <dd dir="ltr">{p.mobile ?? "—"}</dd>
                  </dl>
                </section>

                <section className="sru-profile-group">
                  <h3>{t("jobGroup")}</h3>
                  <dl>
                    <dt>{t("orgUnitLabel")}</dt>
                    <dd>{p.org_units?.name_ar ?? "—"}</dd>
                    <dt>{t("jobTitleLabel")}</dt>
                    <dd>
                      {p.job_titles?.name_ar ?? "—"}
                      {/* The HR file's free-text title, kept as a hint until an official title is chosen (2026-10-15 bulk onboarding). */}
                      {!p.job_titles && p.job_title_hint && (
                        <span style={{ display: "block", fontSize: 11, color: "var(--sru-muted)" }}>{t("jobTitleHint", { hint: p.job_title_hint })}</span>
                      )}
                    </dd>
                    <dt>{t("hireDateLabel")}</dt>
                    <dd>{p.hire_date ? formatDateDmy(p.hire_date, locale) : "—"}</dd>
                    <dt>{t("supervisorLabel")}</dt>
                    <dd>{supervisor?.full_name_ar ?? t("supervisorNone")}</dd>
                  </dl>
                </section>

                <section className="sru-profile-group">
                  <h3>{t("qualificationsGroup")}</h3>
                  <dl>
                    <dt>{t("qualificationLabel")}</dt>
                    <dd>{p.qualification ?? "—"}</dd>
                    <dt>{t("specialityLabel")}</dt>
                    <dd>{p.education_speciality ?? "—"}</dd>
                    {/* One certificate per line (20260821000001), listed as
                        written rather than squeezed onto one line. */}
                    <dt>{t("certificatesLabel")}</dt>
                    <dd>
                      {/* The one field on this screen the employee owns. */}
                      <MyCertificatesEditor certificates={p.certificates ?? ""} />
                    </dd>
                  </dl>
                </section>
              </div>
            </div>
          ),
        },
        {
          id: "my-kpis",
          label: t("kpisTitle"),
          content: (
            <>
              <p style={{ color: "var(--sru-muted)", fontSize: 11.5, marginBottom: 12 }}>{t("kpisNote")}</p>

              <section style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{t("planTargetsHeading")}</h3>
                <p style={{ color: "var(--sru-muted)", fontSize: 11.5, marginBottom: 8 }}>{t("planTargetsNote")}</p>
                {myTargets.length === 0 ? (
                  <p style={{ color: "var(--sru-muted)", fontSize: 12 }}>{t("planTargetsEmpty")}</p>
                ) : (
                  <div className="sru-card">
                    <div className="table-scroll">
                      <table className="admin-matrix">
                        <thead>
                          <tr>
                            <th>{t("planTargetsColumnTitle")}</th>
                            <th>{t("planTargetsColumnPlan")}</th>
                            <th>{t("planTargetsColumnUnit")}</th>
                            <th>{t("planTargetsColumnMyShare")}</th>
                            <th>{t("planTargetsColumnValue")}</th>
                            <th>{t("planTargetsColumnActual")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {myTargets.map((row) => (
                            <tr key={row.id}>
                              <td>{row.title}</td>
                              <td>{row.planName}</td>
                              <td>{row.orgUnitName}</td>
                              <td>
                                {t("planTargetsShareValue", {
                                  ofUnit: String(row.myPercent),
                                  ofTarget: String(row.overallPercent),
                                })}
                              </td>
                              <td>{row.myValue == null ? "—" : row.myValue + " " + row.unit}</td>
                              <td>
                                <ActualValueField
                                  id={row.id}
                                  initialValue={row.actualValue}
                                  unit={row.unit}
                                  label={t("planTargetsColumnActual")}
                                  canEdit
                                  action={recordEmployeeActual}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>
              {!goals || goals.length === 0 ? (
                <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{t("goalsEmpty")}</p>
              ) : (
                <div className="sru-card">
                  <div className="table-scroll">
                    <table className="admin-matrix">
                      <thead>
                        <tr>
                          <th>{t("goalsColumnTitle")}</th>
                          <th>{t("goalsColumnCycle")}</th>
                          <th>{t("goalsColumnWeight")}</th>
                          <th>{t("goalsColumnStatus")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {goals.map((goal) => (
                          <tr key={goal.id}>
                            <td>{goal.goal_library?.title_ar ?? goal.custom_title_ar ?? "—"}</td>
                            <td>{goal.evaluation_cycles?.name_ar ?? "—"}</td>
                            <td>{goal.weight != null ? `${goal.weight}%` : "—"}</td>
                            <td>{goal.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ),
        },
        {
          id: "my-tasks",
          label: t("tasksTitle"),
          content:
            !tasks || tasks.length === 0 ? (
              <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{t("tasksEmpty")}</p>
            ) : (
              <div className="sru-card">
                <div className="table-scroll">
                  <table className="admin-matrix">
                    <thead>
                      <tr>
                        <th>{t("tasksColumnTitle")}</th>
                        <th>{t("tasksColumnCycle")}</th>
                        <th>{t("tasksColumnWeight")}</th>
                        <th>{t("tasksColumnStatus")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((task) => (
                        <tr key={task.id}>
                          <td>{task.title_ar}</td>
                          <td>{task.evaluation_cycles?.name_ar ?? "—"}</td>
                          <td>{task.weight != null ? `${task.weight}%` : "—"}</td>
                          <td>{task.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ),
        },
        {
          id: "my-competencies",
          label: t("competenciesTitle"),
          content: myCompetencies.length > 0 ? (
            // What my direct manager actually set for me, with the level
            // required of me. The full framework below is only the fallback
            // for someone nobody has assessed yet — showing 27 generic chips
            // to a person whose manager HAS decided would hide the real
            // answer behind a catalogue.
            <>
              <p style={{ color: "var(--sru-muted)", fontSize: 11.5, marginBottom: 12 }}>
                {t("myCompetenciesNote")}
              </p>
              <div className="table-scroll">
                <table className="admin-matrix">
                  <thead>
                    <tr>
                      <th>{t("myCompetenciesColumnName")}</th>
                      <th>{t("myCompetenciesColumnLevel")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myCompetencies.map((row) => (
                      <tr key={row.id}>
                        <td>{row.competencies?.name_ar ?? "—"}</td>
                        <td>
                          <span className="sru-chip">{behavioralLevelLabels[row.required_level]}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              {/* Fallback only: nobody has set this person's competencies yet.
                  competencies.job_family_id is populated on 0 of 27 rows, so
                  there is still nothing to personalise by here either — the
                  note says so rather than implying this list is theirs. */}
              <p style={{ color: "var(--sru-muted)", fontSize: 11.5, marginBottom: 12 }}>
                {t("competenciesNote")}
              </p>
              {pillars.map((pillar) => {
                const items = getCompetenciesByPillar(pillar);
                return (
                  <div key={pillar} style={{ marginBottom: 16 }}>
                    <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--sru-blue)", marginBottom: 8 }}>
                      {pillar}
                    </h3>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {items.map((c) => (
                        <span key={c.id} className="sru-chip">
                          {c.name}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          ),
        },
        {
          id: "career-path",
          label: t("careerPathTitle"),
          content: !p.job_title_id || !careerTree ? (
            <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{t("careerPathNoJobTitle")}</p>
          ) : (
            <div>
              <CareerPathForwardTree
                currentJobTitleId={p.job_title_id}
                tree={careerTree}
                jobTitleInfo={careerJobTitleInfo}
                labels={{
                  currentJobLabel: t("careerPathCurrentJobLabel"),
                  gradeLabel: (grade) => t("gradeLabel", { grade }),
                  requirementsLabel: t("careerPathColumnRequirements"),
                  descriptionLabel: t("careerPathJobDescription"),
                  noDescriptionLabel: t("careerPathNoDescription"),
                  competenciesLabel: t("careerPathRequiredCompetencies"),
                  noCompetenciesLabel: t("careerPathNoCompetencies"),
                  pendingApprovalLabel: t("careerPathPendingApproval"),
                }}
              />
              {careerTree.children.length === 0 && (
                <p style={{ color: "var(--sru-muted)", fontSize: 13, marginTop: 16 }}>{t("careerPathEmpty")}</p>
              )}
            </div>
          ),
        },
        {
          id: "my-performance",
          label: t("performanceTitle"),
          content: (
            <>
              <p style={{ color: "var(--sru-muted)", fontSize: 11.5, marginBottom: 12 }}>{t("performanceNote")}</p>
              {!evaluationsList || evaluationsList.length === 0 ? (
                <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{t("performanceEvaluationsEmpty")}</p>
              ) : (
                <div className="sru-card" style={{ marginBottom: 20 }}>
                  <div className="table-scroll">
                    <table className="admin-matrix">
                      <thead>
                        <tr>
                          <th>{t("performanceColumnCycle")}</th>
                          <th>{t("performanceColumnType")}</th>
                          <th>{t("performanceColumnState")}</th>
                          <th>{t("performanceColumnAvgScore")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {evaluationsList.map((evaluation) => {
                          const scores = scoresByEvaluation.get(evaluation.id) ?? [];
                          const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
                          return (
                            <tr key={evaluation.id}>
                              <td>{evaluation.evaluation_cycles?.name_ar ?? "—"}</td>
                              <td>{evalTypeLabels[evaluation.eval_type as EvalType] ?? evaluation.eval_type}</td>
                              <td>{evaluationStateLabels[evaluation.state as EvaluationState] ?? evaluation.state}</td>
                              <td>{avg != null ? `${avg.toFixed(1)}%` : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <h3 style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 10 }}>{t("calibrationTitle")}</h3>
              {!calibrationResults || calibrationResults.length === 0 ? (
                <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{t("calibrationEmpty")}</p>
              ) : (
                <div className="sru-card">
                  <div className="table-scroll">
                    <table className="admin-matrix">
                      <thead>
                        <tr>
                          <th>{t("calibrationColumnCycle")}</th>
                          <th>{t("calibrationColumnOriginal")}</th>
                          <th>{t("calibrationColumnCalibrated")}</th>
                          <th>{t("calibrationColumnJustification")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {calibrationResults.map((result) => (
                          <tr key={result.id}>
                            <td>{result.calibration_sessions?.evaluation_cycles?.name_ar ?? "—"}</td>
                            <td>{result.original_rating != null ? `${result.original_rating}%` : "—"}</td>
                            <td>{result.calibrated_rating != null ? `${result.calibrated_rating}%` : "—"}</td>
                            <td>{result.justification ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ),
        },
      ];

  // The split itself, stated once. The queries above are already gated by
  // `wantsWork`, so the half that is not asked for costs nothing to skip here.
  return wantsWork ? tabs.filter((tab) => tab.id !== "my-data") : tabs.filter((tab) => tab.id === "my-data");
}
