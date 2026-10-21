"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateCycleEvaluations, type GenerateOutcome } from "@/lib/cycleEvaluations";
import { runEvaluationReminders, type ReminderRunOutcome } from "@/lib/evaluationReminders";
import { todayInTimezone } from "@/lib/evaluationCycle";

export type GenerateCycleEvaluationsState =
  | ({ status: "success" } & GenerateOutcome)
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "forbidden" | "not_found" | "unknown" }
  | null;

/**
 * Launches a cycle: one draft supervisor evaluation per eligible employee
 * (phase 2 item 5). Gated on a GLOBAL evaluation=approve — launching is a
 * whole-population act, not a per-unit one; the inserts then also pass
 * `evaluations_insert` row by row. `dryRun=1` returns the plan only.
 */
export async function generateCycleEvaluationsAction(
  _prev: GenerateCycleEvaluationsState,
  formData: FormData
): Promise<GenerateCycleEvaluationsState> {
  const parsed = z.object({ cycleId: z.string().uuid(), dryRun: z.enum(["0", "1"]).default("0") }).safeParse({
    cycleId: formData.get("cycleId"),
    dryRun: formData.get("dryRun") ?? "0",
  });
  if (!parsed.success) return { status: "error", message: "invalid_input" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "unauthenticated" };

  const { data: canLaunch } = await supabase.rpc("check_vpra_global", { p_process_area: "evaluation", p_min_level: "approve" });
  if (!canLaunch) return { status: "error", message: "forbidden" };

  const outcome = await generateCycleEvaluations(supabase, parsed.data.cycleId, parsed.data.dryRun === "1");
  if (!outcome) return { status: "error", message: "not_found" };

  if (!outcome.dryRun) {
    const admin = createAdminClient();
    await admin.from("audit_log").insert({
      actor_id: user.id,
      action: "cycle_evaluations_generated",
      entity: "evaluation_cycles",
      entity_id: parsed.data.cycleId,
      after_data: {
        created: outcome.created,
        eligible: outcome.summary.eligible,
        already_existing: outcome.summary.existing,
        not_ready: outcome.summary.notReady.length,
        errors: outcome.errors.length,
      },
    });
  }
  return { status: "success", ...outcome };
}

const dateOrNull = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null))
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable());

export type CycleDeadlinesState =
  | { status: "success" }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "forbidden" | "unknown" }
  | null;

/** Saves the four phase deadlines (20261021000002); the table keeps them ordered, approvers only (evaluation_cycles_update RLS). */
export async function updateCycleDeadlinesAction(_prev: CycleDeadlinesState, formData: FormData): Promise<CycleDeadlinesState> {
  const parsed = z
    .object({ cycleId: z.string().uuid(), deadline_submit: dateOrNull, deadline_supervisor: dateOrNull, deadline_recommend: dateOrNull, deadline_approve: dateOrNull })
    .safeParse({
      cycleId: formData.get("cycleId"),
      deadline_submit: formData.get("deadline_submit") ?? undefined,
      deadline_supervisor: formData.get("deadline_supervisor") ?? undefined,
      deadline_recommend: formData.get("deadline_recommend") ?? undefined,
      deadline_approve: formData.get("deadline_approve") ?? undefined,
    });
  if (!parsed.success) return { status: "error", message: "invalid_input" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "unauthenticated" };

  const { cycleId, ...deadlines } = parsed.data;
  const { data: updated, error } = await supabase.from("evaluation_cycles").update(deadlines).eq("id", cycleId).is("deleted_at", null).select("id");
  if (error) return { status: "error", message: error.code === "23514" ? "invalid_input" : "unknown" };
  if (!updated || updated.length === 0) return { status: "error", message: "forbidden" };

  const admin = createAdminClient();
  await admin.from("audit_log").insert({ actor_id: user.id, action: "evaluation_cycle_deadlines_updated", entity: "evaluation_cycles", entity_id: cycleId, after_data: deadlines });
  return { status: "success" };
}

export type RemindersRunState =
  | ({ status: "success" } & ReminderRunOutcome)
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "forbidden" | "unknown" }
  | null;

/** "Send reminders now" for one cycle — the same run the morning schedule performs. Global approvers only. */
export async function runEvaluationRemindersAction(_prev: RemindersRunState, formData: FormData): Promise<RemindersRunState> {
  const parsed = z.object({ cycleId: z.string().uuid() }).safeParse({ cycleId: formData.get("cycleId") });
  if (!parsed.success) return { status: "error", message: "invalid_input" };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "unauthenticated" };
  const { data: canRun } = await supabase.rpc("check_vpra_global", { p_process_area: "evaluation", p_min_level: "approve" });
  if (!canRun) return { status: "error", message: "forbidden" };

  const admin = createAdminClient();
  const outcome = await runEvaluationReminders(admin, todayInTimezone("Asia/Riyadh"), parsed.data.cycleId);
  await admin.from("audit_log").insert({ actor_id: user.id, action: "evaluation_reminders_run", entity: "evaluation_cycles", entity_id: parsed.data.cycleId, after_data: { source: "manual", ...outcome } });
  return { status: "success", ...outcome };
}
