import { evaluationMethods, type EvaluationMethod, type MethodWeights } from "./evaluationCycle";

/**
 * Completeness gate before approval (gap analysis 2026-10-18, phase 1 item 4).
 *
 * Rule (owner-approved 2026-10-18): an evaluation may not be approved while a
 * method that carries weight in the employee's distribution has no score at
 * all. The one exception is 360 when the cycle has no linked 360 cycle — then
 * nothing could ever have produced that number. An approver may override the
 * gate with a recorded reason.
 *
 * Pure: the caller passes the resolved weights, the per-method averages the
 * snapshot already holds, and whether a 360 cycle is linked.
 */
export interface CompletenessInput {
  weights: MethodWeights;
  methodScores: Partial<Record<EvaluationMethod, number | null>>;
  hasThreeSixtyCycle: boolean;
}

export interface CompletenessVerdict {
  complete: boolean;
  /** Methods that carry weight, could have been scored, and were not. */
  missingRequired: EvaluationMethod[];
}

export function assessCompleteness(input: CompletenessInput): CompletenessVerdict {
  const missingRequired = evaluationMethods.filter((method) => {
    if (!(input.weights[method] > 0)) return false;
    if (method === "feedback360" && !input.hasThreeSixtyCycle) return false;
    const value = input.methodScores[method];
    return value == null || !Number.isFinite(value);
  });
  return { complete: missingRequired.length === 0, missingRequired };
}
