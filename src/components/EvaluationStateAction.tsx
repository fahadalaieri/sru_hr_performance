"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import {
  finalizeEvaluation,
  reopenEvaluation,
  transitionEvaluation,
  type ReopenEvaluationState,
} from "@/app/[locale]/(app)/evaluations/[id]/actions";
import { evaluationStateLabels, evaluationStates, nextEvaluationState, type EvaluationState } from "@/lib/vpra";

const errorMessageKeys: Record<string, string> = {
  invalid_input: "errorInvalidInput",
  unauthenticated: "errorUnauthenticated",
  not_found: "errorNotFound",
  forbidden: "errorForbidden",
  no_result: "errorNoResult",
  unknown: "errorUnknown",
};

/**
 * The lifecycle controls of one evaluation (2026-10-18):
 *  - before `approved`: the single "advance" step (the database decides who
 *    may take it — 20261018000001; this only shows the button);
 *  - at `approved`: approvers see "finalize" (stores nothing new, locks for
 *    good); everyone else sees that it awaits finalization;
 *  - at `finalized`: a closed notice;
 *  - approvers also get "reopen" to an earlier state with a mandatory reason,
 *    which retires the stored result (20261018000002).
 */
export function EvaluationStateAction({
  evaluationId,
  currentState,
  canApprove,
}: {
  evaluationId: string;
  currentState: EvaluationState;
  canApprove: boolean;
}) {
  const t = useTranslations("EvaluationDetailPage");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ status: "success" } | { status: "error"; message: string } | null>(null);
  const [reopenState, reopenAction, reopening] = useActionState<ReopenEvaluationState, FormData>(reopenEvaluation, null);

  useEffect(() => {
    if (reopenState?.status === "success") router.refresh();
  }, [reopenState, router]);

  const target = nextEvaluationState(currentState);
  const run = (fn: () => Promise<{ status: "success" } | { status: "error"; message: string }>) => {
    setResult(null);
    startTransition(async () => {
      const res = await fn();
      if (res.status === "success") {
        setResult({ status: "success" });
        router.refresh();
      } else {
        setResult(res);
      }
    });
  };

  const earlierStates = evaluationStates.filter((s) => evaluationStates.indexOf(s) < evaluationStates.indexOf(currentState));

  return (
    <div>
      {currentState === "finalized" ? (
        <p style={{ color: "var(--sru-muted)", fontSize: 12 }}>{t("finalizedNote")}</p>
      ) : currentState === "approved" ? (
        canApprove ? (
          <button type="button" disabled={isPending} onClick={() => run(() => finalizeEvaluation(evaluationId))} className="sru-btn sru-btn-primary">
            {isPending ? t("finalizing") : t("finalizeButton")}
          </button>
        ) : (
          <p style={{ color: "var(--sru-muted)", fontSize: 12 }}>{t("awaitingFinalize")}</p>
        )
      ) : target ? (
        <button type="button" disabled={isPending} onClick={() => run(() => transitionEvaluation(evaluationId))} className="sru-btn sru-btn-primary">
          {isPending ? t("advancing") : t("advanceTo", { state: evaluationStateLabels[target] })}
        </button>
      ) : (
        <p style={{ color: "var(--sru-muted)", fontSize: 12 }}>{t("noFurtherTransition")}</p>
      )}

      {result?.status === "success" && (
        <p role="status" style={{ color: "var(--sru-success, #15803d)", fontSize: 12, marginTop: 8 }}>
          {t("advanceSuccess")}
        </p>
      )}
      {result?.status === "error" && (
        <p role="alert" style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>
          {t(errorMessageKeys[result.message] ?? "errorUnknown")}
        </p>
      )}

      {canApprove && earlierStates.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--sru-purple)" }}>{t("reopenHeading")}</summary>
          <form action={reopenAction} style={{ display: "grid", gap: 8, marginTop: 10, maxWidth: 520 }}>
            <input type="hidden" name="evaluationId" value={evaluationId} />
            <label style={{ fontSize: 12 }}>
              {t("reopenTarget")}
              <select name="toState" defaultValue={earlierStates[earlierStates.length - 1]} style={{ display: "block", marginTop: 4 }}>
                {earlierStates.map((s) => (
                  <option key={s} value={s}>{evaluationStateLabels[s]}</option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 12 }}>
              {t("reopenReason")}
              <textarea name="reason" required minLength={5} maxLength={1000} rows={3} style={{ display: "block", width: "100%", marginTop: 4 }} />
            </label>
            <div>
              <button type="submit" disabled={reopening} className="sru-btn sru-btn-secondary">
                {reopening ? t("reopening") : t("reopenButton")}
              </button>
            </div>
            {reopenState?.status === "error" && (
              <p role="alert" style={{ color: "#dc2626", fontSize: 12, margin: 0 }}>
                {t(errorMessageKeys[reopenState.message] ?? "errorUnknown")}
              </p>
            )}
          </form>
        </details>
      )}
    </div>
  );
}
