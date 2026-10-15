"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reviewApprovalSchema } from "./approvalSchema";

const deleteSchema = z.object({ profileId: z.string().uuid() });

export type DeleteEmployeeState =
  | { status: "success" }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "forbidden" | "unknown" }
  | null;

/**
 * Soft-deletes a `profiles` row (2026-07-24, View/Edit/Delete row actions
 * request) — sets `deleted_at`, never a real DELETE, per CLAUDE.md §5-A
 * rule 7. Goes through the caller's own RLS-respecting client; real
 * authorization is `profiles_update`'s own `check_vpra('employeeData',
 * 'prepare', org_unit_id)` (a soft-delete is just an UPDATE), same as
 * `updateEmployee`. The UI only shows the Delete button at the higher
 * `'approve'` bar, matching the Edit button's own gate.
 */
export async function deleteEmployee(_prevState: DeleteEmployeeState, formData: FormData): Promise<DeleteEmployeeState> {
  const parsed = deleteSchema.safeParse({ profileId: formData.get("profileId") });
  if (!parsed.success) {
    return { status: "error", message: "invalid_input" };
  }

  const supabase = await createClient();
  const {
    data: { user: actor },
  } = await supabase.auth.getUser();
  if (!actor) {
    return { status: "error", message: "unauthenticated" };
  }

  const { profileId } = parsed.data;

  const { error, count } = await supabase
    .from("profiles")
    .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", profileId)
    .is("deleted_at", null);

  if (error) {
    return { status: "error", message: "unknown" };
  }
  if (!count) {
    return { status: "error", message: "forbidden" };
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "employee_deleted",
    entity: "profiles",
    entity_id: profileId,
  });

  return { status: "success" };
}

export type ReviewEmployeeApprovalState =
  | { status: "success" }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "forbidden" | "unknown" }
  | null;

/**
 * Approves or rejects a 'pending' employee-data submission (2026-07-25
 * approval workflow — "لا يضاف للقائمة الا بعد الاعتماد ممن لديه الاعتماد").
 * `profiles_update`'s own RLS only requires `employeeData`='prepare' (the
 * same bar a normal edit needs), which is deliberately too low for a review
 * decision — checked explicitly here at 'approve', scoped to the employee's
 * own org unit, same discipline as `inviteEmployee`'s userManagement check.
 * Rejected records are kept (soft — CLAUDE.md §5-A rule 7), visible only to
 * their preparer (`created_by`) and to other approve-level holders, never
 * on the main list.
 */
export async function reviewEmployeeApproval(
  _prevState: ReviewEmployeeApprovalState,
  formData: FormData
): Promise<ReviewEmployeeApprovalState> {
  const parsed = reviewApprovalSchema.safeParse({
    profileId: formData.get("profileId"),
    decision: formData.get("decision"),
    orgUnitId: formData.get("orgUnitId") ?? undefined,
    jobTitleId: formData.get("jobTitleId") ?? undefined,
    supervisorId: formData.get("supervisorId") ?? undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: "invalid_input" };
  }

  const supabase = await createClient();
  const {
    data: { user: actor },
  } = await supabase.auth.getUser();
  if (!actor) {
    return { status: "error", message: "unauthenticated" };
  }

  const { profileId, decision, orgUnitId, jobTitleId, supervisorId } = parsed.data;

  const { data: target } = await supabase
    .from("profiles")
    .select("org_unit_id, approval_status, job_title_id, supervisor_id")
    .eq("id", profileId)
    .maybeSingle();
  if (!target) {
    return { status: "error", message: "forbidden" };
  }

  const { data: canApprove } = await supabase.rpc("check_vpra", {
    p_process_area: "employeeData",
    p_min_level: "approve",
    p_target_org_unit: target.org_unit_id,
  });
  if (!canApprove) {
    return { status: "error", message: "forbidden" };
  }

  // Placement (2026-10-15): only on approval, only what the approver chose.
  // Moving the employee into ANOTHER unit needs approve on that unit too — a
  // scoped approver must not place people outside their own scope.
  const placement: Record<string, string> = {};
  if (decision === "approved") {
    if (orgUnitId && orgUnitId !== target.org_unit_id) {
      const { data: canApproveThere } = await supabase.rpc("check_vpra", {
        p_process_area: "employeeData",
        p_min_level: "approve",
        p_target_org_unit: orgUnitId,
      });
      if (!canApproveThere) {
        return { status: "error", message: "forbidden" };
      }
      placement.org_unit_id = orgUnitId;
    }
    if (jobTitleId && jobTitleId !== target.job_title_id) placement.job_title_id = jobTitleId;
    if (supervisorId && supervisorId !== target.supervisor_id) placement.supervisor_id = supervisorId;
  }

  const { error } = await supabase.from("profiles").update({ approval_status: decision, ...placement }).eq("id", profileId);
  if (error) {
    return { status: "error", message: "unknown" };
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "employee_approval_reviewed",
    entity: "profiles",
    entity_id: profileId,
    before_data: { approval_status: target.approval_status, org_unit_id: target.org_unit_id, job_title_id: target.job_title_id, supervisor_id: target.supervisor_id },
    after_data: { approval_status: decision, ...placement },
  });

  return { status: "success" };
}
