"use client";

import { useActionState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { DateFieldDmy } from "@/components/DateFieldDmy";
import { runEvaluationRemindersAction, updateCycleDeadlinesAction, type CycleDeadlinesState, type RemindersRunState } from "@/app/[locale]/(app)/evaluations/cycles/[id]/generate-actions";
import type { CycleDeadlines } from "@/lib/evaluationDeadlines";

/**
 * The four phase deadlines of a cycle, plus "send reminders now" (phase 2
 * item 7). Approvers edit; everyone else reads. The database keeps the four
 * dates ordered; the scheduled run sends the week/day/overdue reminders every
 * morning, and this button runs the same thing on demand.
 */
export function CycleDeadlinesForm({ cycleId, initial, canEdit }: { cycleId: string; initial: CycleDeadlines; canEdit: boolean }) {
  const t = useTranslations("EvaluationCyclePage");
  const router = useRouter();
  const [state, action, pending] = useActionState<CycleDeadlinesState, FormData>(updateCycleDeadlinesAction, null);
  const [runState, runAction, running] = useActionState<RemindersRunState, FormData>(runEvaluationRemindersAction, null);

  useEffect(() => {
    if (state?.status === "success") router.refresh();
  }, [state, router]);

  const fields: Array<{ name: keyof CycleDeadlines; label: string }> = [
    { name: "deadline_submit", label: t("deadlineSubmit") },
    { name: "deadline_supervisor", label: t("deadlineSupervisor") },
    { name: "deadline_recommend", label: t("deadlineRecommend") },
    { name: "deadline_approve", label: t("deadlineApprove") },
  ];

  return (
    <section className="sru-card" style={{ padding: "12px 14px", marginBottom: 14 }}>
      <h3 style={{ fontSize: 13.5, margin: "0 0 4px" }}>{t("deadlinesHeading")}</h3>
      <p style={{ color: "var(--sru-muted)", fontSize: 12, margin: "0 0 10px", lineHeight: 1.8 }}>{t("deadlinesNote")}</p>
      <form action={action}>
        <input type="hidden" name="cycleId" value={cycleId} />
        <div className="sru-formgrid">
          {fields.map((f) => (
            <div className="sru-field" key={f.name}>
              <label>{f.label}</label>
              <DateFieldDmy name={f.name} defaultValue={initial[f.name] ?? ""} disabled={!canEdit} ariaLabel={f.label} />
            </div>
          ))}
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
            <button type="submit" disabled={pending} className="sru-btn sru-btn-primary sru-btn-slim">
              {pending ? t("deadlinesSaving") : t("deadlinesSave")}
            </button>
            {state?.status === "success" && <span role="status" style={{ color: "var(--sru-success, #15803d)", fontSize: 12 }}>{t("deadlinesSaved")}</span>}
            {state?.status === "error" && <span role="alert" style={{ color: "#b91c1c", fontSize: 12 }}>{t(state.message === "invalid_input" ? "deadlinesInvalid" : "deadlinesError")}</span>}
          </div>
        )}
      </form>
      {canEdit && (
        <form action={runAction} style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="hidden" name="cycleId" value={cycleId} />
          <button type="submit" disabled={running} className="sru-btn sru-btn-slim">
            {running ? t("remindersRunning") : t("remindersRun")}
          </button>
          {runState?.status === "success" && (
            <span role="status" style={{ color: "var(--sru-muted)", fontSize: 12 }}>
              {t("remindersResult", { due: runState.due, sent: runState.sent, skipped: runState.skippedAlreadySent })}
            </span>
          )}
          {runState?.status === "error" && <span role="alert" style={{ color: "#b91c1c", fontSize: 12 }}>{t("deadlinesError")}</span>}
        </form>
      )}
    </section>
  );
}
