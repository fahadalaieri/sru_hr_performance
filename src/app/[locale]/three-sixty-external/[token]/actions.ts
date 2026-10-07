"use server";

import { z } from "zod";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canWriteThreeSixtyResponses,
  type BehavioralLevel,
  type ThreeSixtyAssignmentStatus,
  type ThreeSixtyCycleStatus,
} from "@/lib/threeSixty";
import { evaluateExternalLinkAccess } from "@/lib/threeSixtyExternalLink";
import { validateThreeSixtyResponseWrite } from "@/lib/threeSixtyResponseValidation";
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

/**
 * The items this assignment actually shows. Service role bypasses RLS
 * already, so this reads `job_title_competencies` directly instead of the
 * `get_three_sixty_subject_levels` RPC -- that RPC requires a real
 * `auth.uid()`, which a token-based, unauthenticated request never has (see
 * threeSixtyAssignmentItems.ts's own comment). Shared by save and submit so
 * "what may be answered" and "what must be answered" can never drift apart.
 */
async function applicableItemsForAssignment(
  admin: SupabaseClient,
  assignment: { relationship_code: string; subject_employee_id: string }
) {
  const { data: subjectProfile } = await admin
    .from("profiles")
    .select("job_title_id")
    .eq("id", assignment.subject_employee_id)
    .maybeSingle();
  const { data: levelRows } = subjectProfile?.job_title_id
    ? await admin.from("job_title_competencies").select("competency_id, required_level").eq("job_title_id", subjectProfile.job_title_id)
    : { data: [] };
  return resolveApplicableThreeSixtyItems(
    admin,
    assignment.relationship_code,
    ((levelRows ?? []) as { competency_id: string; required_level: BehavioralLevel }[]).map((r) => ({
      competencyId: r.competency_id,
      requiredLevel: r.required_level,
    }))
  );
}

/**
 * Resolves the token to an assignment the public path may act on: an
 * EXTERNAL rater's assignment whose cycle is still active (see
 * `evaluateExternalLinkAccess` for why internal tokens and closed cycles are
 * refused). Returns null for anything else, so every caller fails closed.
 */
async function resolveAssignmentByToken(admin: ReturnType<typeof createAdminClient>, token: string) {
  const { data } = await admin
    .from("three_sixty_assignments")
    .select("id, subject_employee_id, relationship_code, status, rater_employee_id, external_rater_email, three_sixty_cycles(status)")
    .eq("access_token", token)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const cycle = data.three_sixty_cycles as unknown as { status: ThreeSixtyCycleStatus } | null;
  const access = evaluateExternalLinkAccess({
    raterEmployeeId: data.rater_employee_id,
    externalRaterEmail: data.external_rater_email,
    status: data.status as ThreeSixtyAssignmentStatus,
    cycleStatus: cycle?.status ?? "closed",
  });
  return access.ok ? data : null;
}

/** Best-effort client IP for rate limiting -- same `x-forwarded-for` trust boundary `login` already accepts. */
async function clientIp(): Promise<string> {
  return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** The bearer token never goes into a bucket key verbatim; a short digest is enough to key a counter. */
function tokenBucket(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
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

  // Autosave fires once per answer change, so a real rater needs a few dozen
  // calls per survey; these caps only stop a script hammering a leaked link.
  // Fails open on an RPC error, same posture as `login` (RLS/token stay the
  // real boundary).
  const [tokenOk, ipOk] = await Promise.all([
    checkRateLimit(`three_sixty_external:save:token:${tokenBucket(token)}`, 300, 60 * 60),
    checkRateLimit(`three_sixty_external:save:ip:${await clientIp()}`, 600, 60 * 60),
  ]);
  if (!tokenOk || !ipOk) return { ok: false, message: "unknown" };

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

  // The item must be one this assignment actually shows, the option must
  // belong to the item's own scale, and the stored score comes from the
  // option -- never from the request. This path writes through the
  // service-role client, so the application check is the only one before
  // `validate_three_sixty_response()` (20261006000002) in Postgres.
  const applicableItems = await applicableItemsForAssignment(admin, assignment);
  const item = applicableItems.find((i) => i.id === itemId);
  const { data: optionRows } = item?.scaleCode
    ? await admin
        .from("three_sixty_rating_scale_options")
        .select("id, scale_code, numeric_value")
        .eq("scale_code", item.scaleCode)
        .is("deleted_at", null)
    : { data: [] };
  const validation = validateThreeSixtyResponseWrite(
    item,
    (optionRows ?? []).map((o) => ({ id: o.id, scaleCode: o.scale_code, numericValue: Number(o.numeric_value) })),
    { optionId, numericValue, textValue }
  );
  if (!validation.ok) return { ok: false, message: "invalid_input" };

  const { data: existing } = await admin
    .from("three_sixty_responses")
    .select("id")
    .eq("assignment_id", assignment.id)
    .eq("item_id", itemId)
    .maybeSingle();

  const patch = {
    assignment_id: assignment.id,
    item_id: itemId,
    ...validation.patch,
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

  const [tokenOk, ipOk] = await Promise.all([
    checkRateLimit(`three_sixty_external:submit:token:${tokenBucket(token)}`, 10, 60 * 60),
    checkRateLimit(`three_sixty_external:submit:ip:${await clientIp()}`, 60, 60 * 60),
  ]);
  if (!tokenOk || !ipOk) return { status: "error", message: "unknown" };

  const admin = createAdminClient();
  const assignment = await resolveAssignmentByToken(admin, token);
  if (!assignment) return { status: "error", message: "forbidden" };
  if (assignment.status !== "pending") return { status: "error", message: "invalid_input" };

  const applicableItems = await applicableItemsForAssignment(admin, assignment);
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
