"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { canWriteThreeSixtyResponses, type BehavioralLevel, type ThreeSixtyAssignmentStatus } from "@/lib/threeSixty";
import { resolveApplicableThreeSixtyItems } from "@/lib/threeSixtyAssignmentItems";

const saveSchema = z.object({
  assignmentId: z.string().uuid(),
  itemId: z.string().uuid(),
  optionId: z.string().uuid().optional(),
  numericValue: z.number().optional(),
  textValue: z.string().max(4000).optional(),
});

export type SaveResponseResult = { ok: true } | { ok: false; message: "forbidden" | "invalid_input" | "unknown" };

/**
 * Screen 3's "حفظ تلقائي للمسودة": called directly from the client on
 * every answer change (rating: on selection; open text: on blur) rather
 * than through a `<form>`/`useActionState` — each item saves
 * independently, so one slow request never blocks the others. Select-then
 * -insert-or-update against `three_sixty_responses_uidx (assignment_id,
 * item_id)` -- a REAL (non-partial) unique index here, but this project's
 * established discipline is still to check first so this stays a plain,
 * predictable UPDATE-or-INSERT rather than relying on `.upsert()`'s
 * PostgREST-inferred ON CONFLICT matching a constraint this table may not
 * keep forever.
 */
export async function saveThreeSixtyResponse(input: {
  assignmentId: string;
  itemId: string;
  optionId?: string;
  numericValue?: number;
  textValue?: string;
}): Promise<SaveResponseResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "invalid_input" };
  const { assignmentId, itemId, optionId, numericValue, textValue } = parsed.data;

  const supabase = await createClient();

  // Answers are writable only while the assignment is still `pending`
  // (20261006000001). RLS enforces the same rule; this check turns a silent
  // zero-row UPDATE into an explicit refusal and never trusts the client's
  // own idea of the assignment's state.
  const { data: assignment } = await supabase
    .from("three_sixty_assignments")
    .select("status")
    .eq("id", assignmentId)
    .maybeSingle();
  if (!assignment) return { ok: false, message: "forbidden" };
  if (!canWriteThreeSixtyResponses(assignment.status as ThreeSixtyAssignmentStatus)) {
    return { ok: false, message: "forbidden" };
  }

  const { data: existing } = await supabase
    .from("three_sixty_responses")
    .select("id")
    .eq("assignment_id", assignmentId)
    .eq("item_id", itemId)
    .maybeSingle();

  const patch = {
    assignment_id: assignmentId,
    item_id: itemId,
    option_id: optionId ?? null,
    numeric_value: numericValue ?? null,
    text_value: textValue ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = existing
    ? await supabase.from("three_sixty_responses").update(patch).eq("id", existing.id)
    : await supabase.from("three_sixty_responses").insert(patch);

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return { ok: false, message: "forbidden" };
    }
    return { ok: false, message: "unknown" };
  }
  return { ok: true };
}

export type SubmitAssignmentState =
  | { status: "success" }
  | { status: "error"; message: "invalid_input" | "forbidden" | "unknown" }
  | null;

/**
 * Final submission -- flips the assignment to 'submitted', locking it from
 * further edits (both `saveThreeSixtyResponse` and this action re-check the
 * assignment's own status server-side; the client only hides the controls).
 * Required items are checked here, not just in the UI, since a client-only
 * check can't be trusted (CLAUDE.md's "never trust the client" rule).
 */
const submitSchema = z.object({ assignmentId: z.string().uuid() });

export async function submitThreeSixtyAssignment(
  _prevState: SubmitAssignmentState,
  formData: FormData
): Promise<SubmitAssignmentState> {
  const parsed = submitSchema.safeParse({ assignmentId: formData.get("assignmentId") });
  if (!parsed.success) return { status: "error", message: "invalid_input" };
  const { assignmentId } = parsed.data;

  const supabase = await createClient();

  const { data: assignment } = await supabase
    .from("three_sixty_assignments")
    .select("id, relationship_code, subject_employee_id, status")
    .eq("id", assignmentId)
    .maybeSingle();
  if (!assignment) return { status: "error", message: "forbidden" };
  if (assignment.status !== "pending") return { status: "error", message: "invalid_input" };

  // Bug found live 2026-09-06: this used to check ALL required items merely
  // matching the rater group (~216 across every behavioral level and every
  // competency), not the ~22 actually resolved for this subject and shown
  // on screen 3 -- since the level split (20260904000003) and specialized-
  // competency scoping (20260905000001) shipped, that meant "missing" could
  // never reach zero and every submission was silently blocked. Sharing the
  // exact same resolver the rendering page uses fixes both at once.
  const { data: levelRows } = await supabase.rpc("get_three_sixty_subject_levels", {
    p_subject_employee_id: assignment.subject_employee_id,
  });
  const applicableItems = await resolveApplicableThreeSixtyItems(
    supabase,
    assignment.relationship_code,
    ((levelRows ?? []) as { competency_id: string; required_level: BehavioralLevel }[]).map((r) => ({
      competencyId: r.competency_id,
      requiredLevel: r.required_level,
    }))
  );
  const applicableRequired = applicableItems.filter((item) => item.required);

  const { data: responses } = await supabase
    .from("three_sixty_responses")
    .select("item_id, option_id, text_value")
    .eq("assignment_id", assignmentId);
  const answered = new Set(
    (responses ?? [])
      .filter((r) => r.option_id != null || (r.text_value != null && r.text_value.trim() !== ""))
      .map((r) => r.item_id)
  );

  const missing = applicableRequired.filter((item) => !answered.has(item.id));
  if (missing.length > 0) {
    return { status: "error", message: "invalid_input" };
  }

  const { error, count } = await supabase
    .from("three_sixty_assignments")
    .update({ status: "submitted" }, { count: "exact" })
    .eq("id", assignmentId)
    .eq("status", "pending");

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return { status: "error", message: "forbidden" };
    }
    return { status: "error", message: "unknown" };
  }
  if (!count) return { status: "error", message: "forbidden" };
  return { status: "success" };
}
