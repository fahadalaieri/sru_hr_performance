"use client";

import { useActionState, startTransition, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import {
  saveEvaluationScores,
  type SaveEvaluationScoresState,
} from "@/app/[locale]/(app)/evaluations/[id]/scores/actions";

interface ScoredSubject {
  id: string;
  titleAr?: string;
  nameAr?: string;
  requiredLevelAr?: string | null;
  initialScore: number | null;
  initialComment: string | null;
}

type ErrorMessage = Extract<SaveEvaluationScoresState, { status: "error" }>["message"];

const errorMessageKeys: Record<ErrorMessage, string> = {
  invalid_input: "errorInvalidInput",
  unauthenticated: "errorUnauthenticated",
  not_found: "errorNotFound",
  forbidden: "errorForbidden",
  locked: "errorLocked",
  unknown: "errorUnknown",
};

export function EvaluationScoresForm({
  evaluationId,
  competencies,
  competenciesNote,
  activities,
  bauTasks = [],
  showCompetencies = true,
  showActivities = true,
  showBau = true,
}: {
  evaluationId: string;
  competencies: ScoredSubject[];
  competenciesNote?: string;
  activities: ScoredSubject[];
  bauTasks?: ScoredSubject[];
  showCompetencies?: boolean;
  showActivities?: boolean;
  showBau?: boolean;
}) {
  const t = useTranslations("EvaluationScoresPage");
  const [state, formAction, pending] = useActionState<SaveEvaluationScoresState, FormData>(
    saveEvaluationScores.bind(null, evaluationId),
    null
  );

  const scoreInputClass =
    "w-24 px-2 py-1 border border-[var(--border)] bg-[var(--background)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]";
  const commentInputClass =
    "w-full px-2 py-1 border border-[var(--border)] bg-[var(--background)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]";

  function renderRows(prefix: "competency" | "activity" | "bau", subjects: ScoredSubject[], showRequiredLevel = false) {
    return subjects.map((subject) => (
      <tr key={subject.id}>
        <td>{subject.nameAr ?? subject.titleAr}</td>
        {showRequiredLevel && (
          <td style={{ color: "var(--sru-muted)", fontSize: 12.5 }}>{subject.requiredLevelAr ?? "—"}</td>
        )}
        <td>
          <input
            type="text" inputMode="decimal"
            min={0}
            max={100}
            step="0.1"
            name={`score_${prefix}_${subject.id}`}
            defaultValue={subject.initialScore ?? ""}
            className={scoreInputClass}
          />
        </td>
        <td>
          <input
            type="text"
            name={`comment_${prefix}_${subject.id}`}
            defaultValue={subject.initialComment ?? ""}
            className={commentInputClass}
          />
        </td>
      </tr>
    ));
  }

  // See EmployeeInviteForm.tsx: React 19's <form action={fn}> resets every
  // uncontrolled field after ANY submission, success or error alike -- here
  // that would wipe every competency/goal's just-entered score/comment on a
  // single validation error, not just the one that failed.
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      formAction(formData);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {showCompetencies ? (
      <div>
        <h2 className="sru-title" style={{ fontSize: 16, marginBottom: 8 }}>
          {t("competenciesHeading")}
        </h2>
        {competenciesNote && (
          <p style={{ color: "var(--sru-muted)", fontSize: 12.5, marginTop: -4, marginBottom: 10 }}>
            {competenciesNote}
          </p>
        )}
        {competencies.length === 0 ? (
          <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{t("competenciesEmpty")}</p>
        ) : (
          <div className="sru-card">
            <div className="table-scroll">
              <table className="admin-matrix">
                <thead>
                  <tr>
                    <th>{t("columnSubject")}</th>
                    <th>{t("columnRequiredLevel")}</th>
                    <th>{t("columnScore")}</th>
                    <th>{t("columnComment")}</th>
                  </tr>
                </thead>
                <tbody>{renderRows("competency", competencies, true)}</tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      ) : null}

      {showActivities ? (
      <div>
        <h2 className="sru-title" style={{ fontSize: 16, marginBottom: 8 }}>
          {t("activitiesHeading")}
        </h2>
        {activities.length === 0 ? (
          <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{t("activitiesEmpty")}</p>
        ) : (
          <div className="sru-card">
            <div className="table-scroll">
              <table className="admin-matrix">
                <thead>
                  <tr>
                    <th>{t("columnSubject")}</th>
                    <th>{t("columnScore")}</th>
                    <th>{t("columnComment")}</th>
                  </tr>
                </thead>
                <tbody>{renderRows("activity", activities)}</tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      ) : null}

      {showBau ? (
      <div>
        <h2 className="sru-title" style={{ fontSize: 16, marginBottom: 8 }}>
          {t("bauHeading")}
        </h2>
        {bauTasks.length === 0 ? (
          <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{t("bauEmpty")}</p>
        ) : (
          <div className="sru-card">
            <div className="table-scroll">
              <table className="admin-matrix">
                <thead>
                  <tr>
                    <th>{t("columnSubject")}</th>
                    <th>{t("columnScore")}</th>
                    <th>{t("columnComment")}</th>
                  </tr>
                </thead>
                <tbody>{renderRows("bau", bauTasks)}</tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      ) : null}

      {state?.status === "error" && (
        <p role="alert" className="text-sm text-red-600">
          {t(errorMessageKeys[state.message])}
        </p>
      )}
      {state?.status === "success" && (
        <p role="status" style={{ color: "var(--sru-success, #15803d)", fontSize: 12 }}>
          {t("successMessage")}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="sru-btn sru-btn-primary"
      >
        {pending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
