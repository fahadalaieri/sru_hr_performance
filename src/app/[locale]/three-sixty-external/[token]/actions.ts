"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { canWriteThreeSixtyResponses, type BehavioralLevel, type ThreeSixtyAssignmentStatus } from "@/lib/threeSixty";
import { resolveApplicableThreeSixtyItems } from "@/lib/threeSixtyAssignmentItems";

/**
 * The external-rater survey path (2026-09-06): a customer/beneficiary with
 * no `profiles` row and no Supabase Auth account at all fills this in via
 * an emailed link carrying `three_sixty_assignments.access_token` -- no
 * login, matching the "نموذج Google Forms" request directly. Every action
 * here uses the SERVICE-ROLE client and re-resolves the assignment FROM THE
 * TOKEN itself on every call -- never trusts a client-supplied assignmentId
 * -- because there is no Supabase session for RLS to gate against; the
 * token's own unguessability (a random UUID, never exposed except in the
 * emailed/copied link) is the entire authorization boundary, the same
 * trust model this app's password-reset links already rely on. This is a
 * deliberate, new exception to `createAdminClient()`'s "don't use this to
 * work around RLS" rule -- there is no authenticated caller to have an RLS
 * policy for in the first place.
 */

const saveSchema = z.object({
  token: z.string().uuid(),
  itemId: z.string().uuid(),
  optionId: z.string().uuid().optional(),
  numericValue: z.number().optional(),
  textValue: z.string().max(4000).optional(),
});

export type SaveResponseResult = { ok: true } | { ok: false; message: "forbidden" | "invalid_input" | "unknown" };

async function resolveAssignmentByToken(admin: ReturnType<typeof createAdminClient>, token: string) {
  const { data } = await admin
    .from("three_sixty_assignments")
    .select("id, subject_employee_id, relationship_code, status")
    .eq("access_token", token)
    .is("deleted_at", null)
    .maybeSingle();
  return data;
}

export async function saveThreeSixtyExternalResponse(input: {
  token: string;
  itemId: string;
  optionId?: string;
  numericValue?: number;
  textValue?: string;
}): Promise<SaveResponseResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "invalid_input" };
  const { token, itemId, optionId, numericValue, textValue } = parsed.data;

  const admin = createAdminClient();
  const assignment = await resolveAssignmentByToken(admin, token);
  if (!assignment) return { ok: false, message: "forbidden" };
  // Mirrors three_sixty_responses_insert/_update's "status = 'pending'" rule
  // (20261006000001) -- this path bypasses RLS entirely through the
  // service-role client, so the equivalent check has to be re-implemented
  // here explicitly. A submitted assignment is final: its answers were
  // counted, and the link's holder must not be able to rewrite them.
  if (!canWriteThreeSixtyResponses(assignment.status as ThreeSixtyAssignmentStatus)) {
    return { ok: false, message: "forbidden" };
  }

  const { data: existing } = await admin
    .from("three_sixty_responses")
    .select("id")
    .eq("assignment_id", assignment.id)
    .eq("item_id", itemId)
    .maybeSingle();

  const patch = {
    assignment_id: assignment.id,
    item_id: itemId,
    option_id: optionId ?? null,
    numeric_value: numericValue ?? null,
    text_value: textValue ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = existing
    ? await admin.from("three_sixty_responses").update(patch).eq("id", existing.id)
    : await admin.from("three_sixty_responses").insert(patch);

  if (error) return { ok: false, message: "unknown" };
  return { ok: true };
}

export type SubmitExternalAssignmentState =
  | { status: "success" }
  | { status: "error"; message: "invalid_input" | "forbidden" | "unknown" }
  | null;

const submitSchema = z.object({ token: z.string().uuid() });

/** Mirrors submitThreeSixtyAssignment exactly (same required-items resolver, same server-side re-check) -- see that action's own comment for the bug this shared resolver fixes. */
export async function submitThreeSixtyExternalAssignment(
  _prevState: SubmitExternalAssignmentState,
  formData: FormData
): Promise<SubmitExternalAssignmentState> {
  const parsed = submitSchema.safeParse({ token: formData.get("token") });
  if (!parsed.success) return { status: "error", message: "invalid_input" };
  const { token } = parsed.data;

  const admin = createAdminClient();
  const assignment = await resolveAssignmentByToken(admin, token);
  if (!assignment) return { status: "error", message: "forbidden" };
  if (assignment.status !== "pending") return { status: "error", message: "invalid_input" };

  const { data: subjectProfile } = await admin
    .from("profiles")
    .select("job_title_id")
    .eq("id", assignment.subject_employee_id)
    .maybeSingle();
  // Service role bypasses RLS already, so this reads job_title_competencies
  // directly instead of the get_three_sixty_subject_levels RPC -- that RPC
  // requires a real auth.uid(), which a token-based, unauthenticated
  // request never has (see threeSixtyAssignmentItems.ts's own comment).
  const { data: levelRows } = subjectProfile?.job_title_id
    ? await admin.from("job_title_competencies").select("competency_id, required_level").eq("job_title_id", subjectProfile.job_title_id)
    : { data: [] };

  const applicableItems = await resolveApplicableThreeSixtyItems(
    admin,
    assignment.relationship_code,
    ((levelRows ?? []) as { competency_id: string; required_level: BehavioralLevel }[]).map((r) => ({
      competencyId: r.competency_id,
      requiredLevel: r.required_level,
    }))
  );
  const applicableRequired = applicableItems.filter((item) => item.required);

  const { data: responses } = await admin
    .from("three_sixty_responses")
    .select("item_id, option_id, text_value")
    .eq("assignment_id", assignment.id);
  const answered = new Set(
    (responses ?? [])
      .filter((r) => r.option_id != null || (r.text_value != null && r.text_value.trim() !== ""))
      .map((r) => r.item_id)
  );

  const missing = applicableRequired.filter((item) => !answered.has(item.id));
  if (missing.length > 0) return { status: "error", message: "invalid_input" };

  const { error, count } = await admin
    .from("three_sixty_assignments")
    .update({ status: "submitted" }, { count: "exact" })
    .eq("id", assignment.id)
    .eq("status", "pending");
  if (error) return { status: "error", message: "unknown" };
  if (!count) return { status: "error", message: "forbidden" };
  return { status: "success" };
}
