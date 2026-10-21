"use client";

import { useActionState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { generateCycleEvaluationsAction, type GenerateCycleEvaluationsState } from "@/app/[locale]/(app)/evaluations/cycles/[id]/generate-actions";
import { Link } from "@/i18n/navigation";
import type { ContentReadiness, CyclePlanSummary } from "@/lib/cycleEvaluations";
import type { IneligibilityReason } from "@/lib/cycleEligibility";

const reasonKeys: Record<IneligibilityReason, string> = {
  not_active: "reasonNotActive",
  not_approved: "reasonNotApproved",
  no_org_unit: "reasonNoOrgUnit",
  no_supervisor: "reasonNoSupervisor",
  hired_too_late: "reasonHiredTooLate",
};

/**
 * "Launch the cycle": the population, who already has an evaluation, who is
 * not ready and why, and one button that creates the missing ones. The plan
 * shown first is computed server-side on page load; the action recomputes it
 * before writing, so a stale page never creates on stale numbers.
 */
export function CycleLaunchPanel({ cycleId, initial, canLaunch, readiness }: { cycleId: string; initial: CyclePlanSummary; canLaunch: boolean; readiness: ContentReadiness }) {
  const t = useTranslations("EvaluationCyclePage");
  const router = useRouter();
  const [state, action, pending] = useActionState<GenerateCycleEvaluationsState, FormData>(generateCycleEvaluationsAction, null);

  useEffect(() => {
    if (state?.status === "success" && !state.dryRun) router.refresh();
  }, [state, router]);

  const summary = state?.status === "success" ? state.summary : initial;

  return (
    <div>
      <p style={{ color: "var(--sru-muted)", fontSize: 12, marginBottom: 12, lineHeight: 1.8 }}>{t("launchNote")}</p>
      <div className="sru-card" style={{ marginBottom: 14 }}>
        <div className="sru-home-mine">
          <span className="sru-home-tile"><span className="sru-home-tile-label">{t("launchEligible")}</span><strong>{summary.eligible}</strong></span>
          <span className="sru-home-tile"><span className="sru-home-tile-label">{t("launchExisting")}</span><strong>{summary.existing}</strong></span>
          <span className="sru-home-tile"><span className="sru-home-tile-label">{t("launchToCreate")}</span><strong>{summary.toCreate}</strong></span>
          <span className="sru-home-tile"><span className="sru-home-tile-label">{t("launchNotReady")}</span><strong>{summary.notReady.length}</strong></span>
        </div>
      </div>

      {canLaunch ? (
        <form action={action} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
          <input type="hidden" name="cycleId" value={cycleId} />
          <button type="submit" name="dryRun" value="1" disabled={pending} className="sru-btn">
            {t("launchPreview")}
          </button>
          <button type="submit" name="dryRun" value="0" disabled={pending || summary.toCreate === 0} className="sru-btn sru-btn-primary">
            {pending ? t("launching") : t("launchCreate", { count: summary.toCreate })}
          </button>
        </form>
      ) : (
        <p style={{ color: "var(--sru-muted)", fontSize: 12, marginBottom: 14 }}>{t("launchReadOnly")}</p>
      )}

      {state?.status === "error" && (
        <p role="alert" className="sru-auth-alert error" style={{ marginBottom: 12 }}>{t("launchError")}</p>
      )}
      {state?.status === "success" && !state.dryRun && (
        <p role="status" style={{ color: "var(--sru-success, #15803d)", fontSize: 12.5, marginBottom: 12 }}>
          {t("launchDone", { created: state.created })}
          {state.errors.length > 0 ? ` — ${state.errors.join(" | ")}` : ""}
        </p>
      )}
      {state?.status === "success" && state.dryRun && (
        <p role="status" style={{ color: "var(--sru-purple)", fontSize: 12.5, marginBottom: 12 }}>{t("launchPreviewed")}</p>
      )}

      <section className="sru-card" style={{ padding: "12px 14px", marginBottom: 14 }}>
        <h3 style={{ fontSize: 13.5, margin: "0 0 4px" }}>{t("readinessHeading")}</h3>
        <p style={{ color: "var(--sru-muted)", fontSize: 12, margin: "0 0 10px", lineHeight: 1.8 }}>{t("readinessNote")}</p>
        <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12.5, lineHeight: 2 }}>
          <li>
            {t("readinessNoTitle", { count: readiness.withoutJobTitle, eligible: readiness.eligible })} <Link href="/employees">{t("readinessFixEmployees")}</Link>
          </li>
          <li>
            {t("readinessBareTitles", { titles: readiness.titlesWithoutCompetencies, employees: readiness.employeesOnTitlesWithoutCompetencies })} <Link href="/career-path/job-titles">{t("readinessFixTitles")}</Link>
          </li>
          <li>{t("readinessUnitWeights", { count: readiness.unitsWithoutOwnWeights })}</li>
        </ul>
      </section>

      {summary.notReady.length > 0 && (
        <details open={summary.notReady.length <= 12}>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{t("notReadyHeading", { count: summary.notReady.length })}</summary>
          <div className="table-scroll" style={{ marginTop: 8 }}>
            <table className="admin-matrix">
              <thead>
                <tr>
                  <th>{t("columnEmployeeNumber")}</th>
                  <th>{t("columnEmployee")}</th>
                  <th>{t("columnNotReadyReason")}</th>
                </tr>
              </thead>
              <tbody>
                {summary.notReady.map((row) => (
                  <tr key={row.employeeNumber}>
                    <td>{row.employeeNumber}</td>
                    <td>{row.fullNameAr}</td>
                    <td>{row.reasons.map((r) => t(reasonKeys[r])).join("، ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
