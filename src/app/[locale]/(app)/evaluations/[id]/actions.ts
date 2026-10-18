"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  canAdvanceEvaluationState,
  transitionEvaluationState,
  type EvaluationState,
  type RoleCode,
} from "@/lib/vpra";

export type TransitionEvaluationResult =
  | { status: "success"; newState: EvaluationState }
  | {
      status: "error";
      message: "invalid_input" | "unauthenticated" | "not_found" | "forbidden" | "unknown";
    };

/**
 * Server-side-only evaluation lifecycle transition (CLAUDE.md §4-A: "State
 * transitions are server-side only — never trust client-sent state"). The
 * caller never supplies the current or target state — this reads the
 * TRUE current state itself and advances exactly one step, using
 * src/lib/vpra.ts's already-unit-tested `canAdvanceEvaluationState`/
 * `transitionEvaluationState` (the single source of truth for the §4-A
 * table), never a client-provided value.
 *
 * Deliberately does NOT re-implement org-scoping or row ownership here —
 * the SELECT/UPDATE both go through the caller's own RLS-respecting
 * client, so `evaluations`' existing RLS policies (20260718000001) remain
 * the actual authorization boundary for "can this caller touch this row at
 * all." This action only adds the state-machine check on top: "given that
 * the row IS visible/writable to them, does any of their roles hold an
 * actionable (prepare/recommend/approve) level at the row's CURRENT state."
 *
 * Known, deliberate limitation (matches 20260718000001's own documented
 * follow-up): `evaluations`' RLS today only grants non-self write access
 * at `check_vpra('evaluation','approve',...)` — i.e. `hr_admin` — because
 * `employee` and `supervisor` share the identical flat `'prepare'` grant
 * and RLS can't yet tell them apart without a supervisor-relationship
 * column. In practice today this means: an employee CAN submit their own
 * draft (self-row RLS), and hr_admin CAN perform the final
 * committee_reviewed -> approved transition (approve-level RLS) — but a
 * real supervisor/manager/committee member will have their UPDATE
 * silently affect 0 rows (reported here as "forbidden") until that
 * relationship mechanism exists, even though src/lib/vpra.ts's own table
 * says their role SHOULD be able to advance the state at that point. This
 * action does not attempt to work around that gap (e.g. via the
 * service-role client) — fixing it belongs in the RLS layer, not by
 * re-deriving authorization here. `approved -> finalized` is correctly
 * unreachable through this action for every role: `vpra.ts` models it as
 * system-triggered (no role holds more than `'view'` there), so
 * `canAdvanceEvaluationState` already returns false for it.
 */
export async function transitionEvaluation(
  evaluationId: string
): Promise<TransitionEvaluationResult> {
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
    .select("id, state")
    .eq("id", parsedId.data)
    .is("deleted_at", null)
    .maybeSingle();

  // A missing row and an RLS-blocked row look identical here on purpose —
  // distinguishing them would leak more than the RLS boundary already
  // allows (same reasoning as the employees list page).
  if (!evaluation) {
    return { status: "error", message: "not_found" };
  }

  const currentState = evaluation.state as EvaluationState;

  // Uses the get_my_role_codes() RPC (20260718000007), not a direct
  // user_roles->roles embed query — the embed silently returns nothing for
  // almost every role, because roles_select's RLS requires a
  // userManagement grant with no self-role exemption. See that
  // migration's header for the real bug this works around.
  const { data: roleCodes } = await supabase.rpc("get_my_role_codes");

  const actionableRole = (roleCodes ?? []).find((role: RoleCode) =>
    canAdvanceEvaluationState(currentState, role)
  );

  if (!actionableRole) {
    return { status: "error", message: "forbidden" };
  }

  let nextState: EvaluationState;
  try {
    nextState = transitionEvaluationState(currentState, actionableRole);
  } catch {
    return { status: "error", message: "forbidden" };
  }

  // The extra `.eq("state", currentState)` guards against a race with
  // another transition landing between the read above and this write, on
  // top of RLS's own USING clause re-checked here as a genuine write, not
  // assumed from the SELECT above.
  const { data: updated, error } = await supabase
    .from("evaluations")
    .update({ state: nextState })
    .eq("id", parsedId.data)
    .eq("state", currentState)
    .select("id")
    .maybeSingle();

  if (error) {
    // 23514 = the database state machine (20261018000001) refused the move:
    // wrong relationship for this step, a skipped state, or a reopen by a
    // non-approver. The table, not this action, is the boundary now.
    if (error.code === "23514") return { status: "error", message: "forbidden" };
    return { status: "error", message: "unknown" };
  }

  // 0 rows affected means RLS blocked the write (e.g. a supervisor/manager/
  // committee role not yet covered — see the doc comment above) or the
  // state changed under us — either way, not a success.
  if (!updated) {
    return { status: "error", message: "forbidden" };
  }

  const admin = createAdminClient();
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
