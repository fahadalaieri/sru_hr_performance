"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateCycleEvaluations, type GenerateOutcome } from "@/lib/cycleEvaluations";

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
