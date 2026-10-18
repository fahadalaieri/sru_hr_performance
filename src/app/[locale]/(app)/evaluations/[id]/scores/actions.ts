"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveEvaluationCompetencies } from "@/lib/evaluationCompetencies";
import { collectScoreRows } from "@/lib/evaluationScoreForm";

export type SaveEvaluationScoresState =
  | { status: "success" }
  | {
      status: "error";
      message: "invalid_input" | "unauthenticated" | "not_found" | "forbidden" | "unknown";
    }
  | null;

/**
 * Saves competency/activity/BAU-task scores for one evaluation
 * (`evaluation_scores`, migration 20260718000006). The set of subjects
 * scored is NOT trusted from the client — competencies are re-derived here
 * via the same `resolveEvaluationCompetencies` helper the scores page
 * itself uses (the employee's own job-title competencies, from
 * `job_title_competencies`, falling back to the full framework when none
 * are assigned — 2026-08-31, closing the "no per-employee filtering exists
 * yet" gap this file used to flag), and activities/BAU tasks are re-derived
 * from the employee's own assigned rows, then matched against form fields
 * named `score_competency_<id>` / `comment_competency_<id>` and similarly
 * for `activity`/`bau`. A client can only ever affect rows for subjects
 * that genuinely apply to this evaluation.
 *
 * Each row is written through the caller's own RLS-respecting client —
 * real authorization is `evaluation_scores`' own INSERT/UPDATE policies
 * (self-row has no bypass; `check_vpra('evaluation','approve'|'recommend',
 * ...)` or `is_my_direct_report()` — 20260719000002/000003), not
 * application code. No `upsert()` is used: `evaluation_scores`' uniqueness
 * is enforced via two PARTIAL indexes (`WHERE competency_id IS NOT NULL` /
 * `WHERE goal_id IS NOT NULL`), and PostgREST's `on_conflict` inference
 * doesn't carry a WHERE predicate, so a plain upsert would fail with "no
 * unique or exclusion constraint matching the ON CONFLICT specification."
 * Doing an explicit select-then-insert-or-update per row avoids that
 * entirely, at the cost of more round trips — acceptable for this
 * internal tool's row counts (dozens, not thousands).
 */
export async function saveEvaluationScores(
  evaluationId: string,
  _prevState: SaveEvaluationScoresState,
  formData: FormData
): Promise<SaveEvaluationScoresState> {
  const parsedId = z.string().uuid().safeParse(evaluationId);
  if (!parsedId.success) {
    return { status: "error", message: "invalid_input" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { status: "error", message: "unauthenticated" };
  }

  const { data: evaluation } = await supabase
    .from("evaluations")
    .select("id, employee_id, cycle_id")
    .eq("id", parsedId.data)
    .is("deleted_at", null)
    .maybeSingle();

  if (!evaluation) {
    return { status: "error", message: "not_found" };
  }

  const { data: existingCompetencyScores } = await supabase
    .from("evaluation_scores")
    .select("competency_id")
    .eq("evaluation_id", parsedId.data)
    .not("competency_id", "is", null)
    .is("deleted_at", null);

  const { competencies } = await resolveEvaluationCompetencies(
    supabase,
    evaluation.employee_id,
    (existingCompetencyScores ?? []).map((row) => row.competency_id as string)
  );

  // Activities replaced strategic targets as the "results" subject
  // (20260828000001): the weight is named for what it actually weighs.
  const { data: activities } = await supabase
    .from("initiative_activities")
    .select("id")
    .eq("responsible_profile_id", evaluation.employee_id)
    .is("deleted_at", null);

  // Routine tasks became scorable in 20260827000002 -- until then the cycle
  // could weight them but nothing could carry the score.
  const { data: bauTasks } = await supabase
    .from("bau_tasks")
    .select("id")
    .eq("employee_id", evaluation.employee_id)
    .eq("cycle_id", evaluation.cycle_id)
    .is("deleted_at", null);

  // Only the subjects the form actually posted are written (2026-10-18):
  // the page renders one method at a time, and rebuilding every subject
  // here used to write null over the other methods' saved scores.
  const collected = collectScoreRows(formData, {
    competencies: (competencies ?? []).map((c) => c.id),
    activities: (activities ?? []).map((a) => a.id),
    bauTasks: (bauTasks ?? []).map((t) => t.id),
  });
  if (!collected.ok) {
    return { status: "error", message: "invalid_input" };
  }
  const rows = collected.rows;
  const changes: Array<{ subject: string; id: string; before: { score: number | null; comment: string | null } | null; after: { score: number | null; comment: string | null } }> = [];

  let touchedCompetencies = 0;
  let touchedActivities = 0;
  let touchedBauTasks = 0;

  for (const row of rows) {
    const { data: existing } = await supabase
      .from("evaluation_scores")
      .select("id, score, comment")
      .eq("evaluation_id", parsedId.data)
      .eq(row.subjectColumn, row.subjectId)
      .maybeSingle();

    // Nothing to save and nothing to clear — skip, don't create an
    // all-null row for a subject the reviewer never touched.
    if (!existing && row.score === null && row.comment === null) {
      continue;
    }

    const payload = { score: row.score, comment: row.comment };
    // Unchanged → no write, no audit noise.
    if (existing && existing.score === payload.score && (existing.comment ?? null) === payload.comment) {
      continue;
    }

    const { error } = existing
      ? await supabase.from("evaluation_scores").update(payload).eq("id", existing.id)
      : await supabase
          .from("evaluation_scores")
          .insert({ evaluation_id: parsedId.data, [row.subjectColumn]: row.subjectId, ...payload });

    if (error) {
      if (error.code === "42501" || error.message.includes("row-level security")) {
        return { status: "error", message: "forbidden" };
      }
      if (error.code === "23514") {
        return { status: "error", message: "invalid_input" };
      }
      return { status: "error", message: "unknown" };
    }

    if (row.subjectColumn === "competency_id") touchedCompetencies++;
    else if (row.subjectColumn === "activity_id") touchedActivities++;
    else touchedBauTasks++;
    changes.push({
      subject: row.subjectColumn,
      id: row.subjectId,
      before: existing ? { score: existing.score, comment: existing.comment ?? null } : null,
      after: payload,
    });
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: user.id,
    action: "evaluation_scores_saved",
    entity: "evaluation_scores",
    entity_id: parsedId.data,
    // Before/after per score (2026-10-18): the counters alone could not
    // explain or recover a score that changed.
    before_data: { scores: changes.map((c) => ({ subject: c.subject, id: c.id, ...c.before })) },
    after_data: {
      competencies_saved: touchedCompetencies,
      activities_saved: touchedActivities,
      bau_tasks_saved: touchedBauTasks,
      scores: changes.map((c) => ({ subject: c.subject, id: c.id, ...c.after })),
    },
  });

  return { status: "success" };
}
