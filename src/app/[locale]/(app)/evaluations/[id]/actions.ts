"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildEvaluationResultSnapshot } from "@/lib/evaluationResultSnapshot";
import {
  canAdvanceEvaluationState,
  evaluationStates,
  transitionEvaluationState,
  type EvaluationState,
  type RoleCode,
} from "@/lib/vpra";

export type TransitionEvaluationResult =
  | { status: "success"; newState: EvaluationState }
  | {
      status: "error";
      message: "invalid_input" | "unauthenticated" | "not_found" | "forbidden" | "no_result" | "unknown";
    };

/** Maps a PostgREST/RPC error to the user-facing reason. The database is the boundary (20261018000001/2). */
function mapDbError(error: { code?: string; message: string }): TransitionEvaluationResult {
  if (error.code === "42501") return { status: "error", message: "forbidden" };
  if (error.code === "P0002") return { status: "error", message: "not_found" };
  if (error.code === "23514") {
    if (/no stored result/.test(error.message)) return { status: "error", message: "no_result" };
    return { status: "error", message: "forbidden" };
  }
  return { status: "error", message: "unknown" };
}

/**
 * Server-side-only evaluation lifecycle transition (CLAUDE.md §4-A). The
 * caller never supplies the current or target state — this reads the TRUE
 * current state and advances exactly one step.
 *
 * Since 20261018000001 the database enforces the state machine itself (one
 * forward step by the real relationship, reopen for approvers only); the
 * vpra.ts table here is a pre-check that gives a clearer error before the
 * trigger does. Since 20261018000002 the final step into `approved` goes
 * through `approve_evaluation_with_result`, which stores the official result
 * snapshot and moves the state in ONE transaction, so an approved evaluation
 * never exists without its stored result. `approved → finalized` is
 * `finalizeEvaluation`, reopening is `reopenEvaluation`.
 */
export async function transitionEvaluation(evaluationId: string): Promise<TransitionEvaluationResult> {
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
    .select("id, state, eval_type")
    .eq("id", parsedId.data)
    .is("deleted_at", null)
    .maybeSingle();
  // A missing row and an RLS-blocked row look identical here on purpose.
  if (!evaluation) {
    return { status: "error", message: "not_found" };
  }

  const currentState = evaluation.state as EvaluationState;

  const { data: roleCodes } = await supabase.rpc("get_my_role_codes");
  const actionableRole = (roleCodes ?? []).find((role: RoleCode) => canAdvanceEvaluationState(currentState, role));
  if (!actionableRole) {
    return { status: "error", message: "forbidden" };
  }
  let nextState: EvaluationState;
  try {
    nextState = transitionEvaluationState(currentState, actionableRole);
  } catch {
    return { status: "error", message: "forbidden" };
  }

  const admin = createAdminClient();

  if (nextState === "approved" && evaluation.eval_type === "supervisor") {
    // The number the approver sees on the page is the number that is stored:
    // same engine, same RLS client, computed right before the approval.
    const snapshot = await buildEvaluationResultSnapshot(supabase, parsedId.data);
    if (!snapshot) {
      return { status: "error", message: "no_result" };
    }
    const { data: resultId, error } = await supabase.rpc("approve_evaluation_with_result", {
      p_evaluation_id: parsedId.data,
      p_result: snapshot,
    });
    if (error) return mapDbError(error);
    await admin.from("audit_log").insert({
      actor_id: user.id,
      action: "evaluation_approved_with_result",
      entity: "evaluations",
      entity_id: parsedId.data,
      before_data: { state: currentState },
      after_data: { state: "approved", result_id: resultId, final_score: snapshot.final_score, rating_band: snapshot.rating_band, applied_weight: snapshot.applied_weight, missing_methods: snapshot.missing_methods },
    });
    return { status: "success", newState: "approved" };
  }

  // The extra `.eq("state", currentState)` guards against a race with
  // another transition landing between the read above and this write.
  const { data: updated, error } = await supabase
    .from("evaluations")
    .update({ state: nextState })
    .eq("id", parsedId.data)
    .eq("state", currentState)
    .select("id")
    .maybeSingle();
  if (error) return mapDbError(error);
  // 0 rows affected: RLS hid the row or the state changed under us.
  if (!updated) {
    return { status: "error", message: "forbidden" };
  }

  await admin.from("audit_log").insert({
    actor_id: user.id,
    action: "evaluation_state_transition",
    entity: "evaluations",
    entity_id: parsedId.data,
    before_data: { state: currentState },
    after_data: { state: nextState },
  });

  return { status: "success", newState: nextState };
}

/** approved → finalized, approvers only; a supervisor evaluation is never finalized without its stored result (RPC enforces both). */
export async function finalizeEvaluation(evaluationId: string): Promise<TransitionEvaluationResult> {
  const parsedId = z.string().uuid().safeParse(evaluationId);
  if (!parsedId.success) return { status: "error", message: "invalid_input" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "unauthenticated" };

  const { error } = await supabase.rpc("finalize_evaluation", { p_evaluation_id: parsedId.data });
  if (error) return mapDbError(error);

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: user.id,
    action: "evaluation_finalized",
    entity: "evaluations",
    entity_id: parsedId.data,
    before_data: { state: "approved" },
    after_data: { state: "finalized" },
  });
  return { status: "success", newState: "finalized" };
}

const reopenSchema = z.object({
  evaluationId: z.string().uuid(),
  toState: z.enum(evaluationStates),
  reason: z.string().trim().min(5).max(1000),
});

export type ReopenEvaluationState = TransitionEvaluationResult | null;

/**
 * Moves an evaluation BACK to an earlier state with a recorded reason
 * (approvers only). The RPC retires the stored result (kept as history with
 * the reason) and changes the state in one transaction; the reason is also
 * written to the audit log so the trail reads without the table.
 */
export async function reopenEvaluation(_prev: ReopenEvaluationState, formData: FormData): Promise<ReopenEvaluationState> {
  const parsed = reopenSchema.safeParse({
    evaluationId: formData.get("evaluationId"),
    toState: formData.get("toState"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return { status: "error", message: "invalid_input" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "unauthenticated" };

  const { data: before } = await supabase.from("evaluations").select("state").eq("id", parsed.data.evaluationId).maybeSingle();
  const { error } = await supabase.rpc("reopen_evaluation", {
    p_evaluation_id: parsed.data.evaluationId,
    p_to_state: parsed.data.toState,
    p_reason: parsed.data.reason,
  });
  if (error) return mapDbError(error);

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: user.id,
    action: "evaluation_reopened",
    entity: "evaluations",
    entity_id: parsed.data.evaluationId,
    before_data: { state: before?.state ?? null },
    after_data: { state: parsed.data.toState, reason: parsed.data.reason },
  });
  return { status: "success", newState: parsed.data.toState };
}
