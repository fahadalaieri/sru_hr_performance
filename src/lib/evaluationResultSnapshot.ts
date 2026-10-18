import type { SupabaseClient } from "@supabase/supabase-js";
import type { MethodWeights } from "./evaluationCycle";
import { resolveEvaluationResultsForCycle, type EmployeeCycleResult } from "./evaluationResult";
import { assessCompleteness } from "./evaluationCompleteness";

/**
 * The official-result snapshot stored at approval (20261018000002).
 *
 * `toResultSnapshot` is pure: it turns the live computation the detail page
 * and the results dashboard already show (`computeEmployeeCycleResult`) into
 * the JSON the `approve_evaluation_with_result` RPC stores. The number the
 * approver saw is the number that gets kept — no second calculation path.
 */
export interface EvaluationResultSnapshot {
  weights: MethodWeights;
  weights_source: "cycle" | "orgUnit";
  method_scores: Record<string, number | null>;
  final_score: number | null;
  applied_weight: number;
  missing_methods: string[];
  rating_band: string | null;
  feedback360_percent: number | null;
  scores_count: number;
  /** Weighted methods that could have been scored and were not (gate, 20261018000003). */
  missing_required: string[];
  /** Set only when an approver overrides the gate; stored with the snapshot. */
  override_reason?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function toResultSnapshot(result: EmployeeCycleResult, scoresCount: number, hasThreeSixtyCycle = false): EvaluationResultSnapshot {
  const completeness = assessCompleteness({ weights: result.weights, methodScores: result.methodScores, hasThreeSixtyCycle });
  return {
    weights: result.weights,
    weights_source: result.weightsSource,
    method_scores: {
      activities: result.methodScores.activities == null ? null : round2(result.methodScores.activities),
      competencies: result.methodScores.competencies == null ? null : round2(result.methodScores.competencies),
      bau: result.methodScores.bau == null ? null : round2(result.methodScores.bau),
      feedback360: result.methodScores.feedback360 == null ? null : round2(result.methodScores.feedback360),
    },
    final_score: result.score == null ? null : round2(result.score),
    applied_weight: round2(result.appliedWeight),
    missing_methods: [...result.missing],
    rating_band: result.band?.id ?? null,
    feedback360_percent: result.methodScores.feedback360 == null ? null : round2(result.methodScores.feedback360),
    scores_count: scoresCount,
    missing_required: completeness.missingRequired,
  };
}

/**
 * Loads everything the snapshot needs through the caller's own RLS client
 * and computes it with the same engine as the live screens. Returns null when
 * the evaluation is not a supervisor evaluation (only those carry an official
 * result) or cannot be read by the caller.
 */
export async function buildEvaluationResultSnapshot(supabase: SupabaseClient, evaluationId: string): Promise<EvaluationResultSnapshot | null> {
  const { data: evaluation } = await supabase
    .from("evaluations")
    .select("id, employee_id, cycle_id, eval_type, evaluation_cycles(weight_activities, weight_competencies, weight_bau, weight_feedback_360)")
    .eq("id", evaluationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!evaluation || evaluation.eval_type !== "supervisor") return null;
  const cycle = evaluation.evaluation_cycles as unknown as { weight_activities: number; weight_competencies: number; weight_bau: number; weight_feedback_360: number } | null;
  if (!cycle) return null;
  const cycleWeights: MethodWeights = {
    activities: Number(cycle.weight_activities),
    competencies: Number(cycle.weight_competencies),
    bau: Number(cycle.weight_bau),
    feedback360: Number(cycle.weight_feedback_360),
  };
  const rows = await resolveEvaluationResultsForCycle(supabase, evaluation.cycle_id, cycleWeights, { employeeIds: [evaluation.employee_id] });
  const row = rows.find((r) => r.evaluationId === evaluation.id);
  if (!row) return null;
  const [{ count }, { data: linked360 }] = await Promise.all([
    supabase.from("evaluation_scores").select("id", { count: "exact", head: true }).eq("evaluation_id", evaluation.id).is("deleted_at", null).not("score", "is", null),
    supabase.from("three_sixty_cycles").select("id").eq("evaluation_cycle_id", evaluation.cycle_id).is("deleted_at", null).maybeSingle(),
  ]);
  return toResultSnapshot(row, count ?? 0, Boolean(linked360));
}
