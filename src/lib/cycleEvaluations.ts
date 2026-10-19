import type { SupabaseClient } from "@supabase/supabase-js";
import { planCycleEvaluations, type CyclePlan, type EligibilityProfile, type IneligibilityReason } from "./cycleEligibility";

/**
 * Bulk generation of a cycle's supervisor evaluations (phase 2 item 5).
 *
 * `loadCyclePlan` reads every profile the caller can see (RLS) and the
 * cycle's existing supervisor evaluations, then applies the eligibility rule.
 * `generateCycleEvaluations` inserts one `draft` supervisor evaluation for
 * each employee in `toCreate` through the caller's own RLS client
 * (`evaluations_insert`: approve in the employee's unit) — so only an approver
 * with scope over the whole population creates the whole population.
 * The (employee, cycle, eval_type) unique index makes a re-run idempotent.
 */
export interface PlanProfile extends EligibilityProfile {
  employee_number: string;
  full_name_ar: string;
}

export interface CyclePlanSummary {
  eligible: number;
  existing: number;
  toCreate: number;
  notReady: Array<{ employeeNumber: string; fullNameAr: string; reasons: IneligibilityReason[] }>;
}

export function summarisePlan(plan: CyclePlan<PlanProfile>): CyclePlanSummary {
  return {
    eligible: plan.existing.length + plan.toCreate.length,
    existing: plan.existing.length,
    toCreate: plan.toCreate.length,
    notReady: plan.notReady
      .map((n) => ({ employeeNumber: n.profile.employee_number, fullNameAr: n.profile.full_name_ar, reasons: n.reasons }))
      .sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber, "en", { numeric: true })),
  };
}

export async function loadCyclePlan(supabase: SupabaseClient, cycleId: string): Promise<CyclePlan<PlanProfile> | null> {
  const { data: cycle } = await supabase.from("evaluation_cycles").select("id, start_date, end_date").eq("id", cycleId).is("deleted_at", null).maybeSingle();
  if (!cycle) return null;
  const [{ data: profiles }, { data: evaluations }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, employee_number, full_name_ar, status, approval_status, org_unit_id, supervisor_id, hire_date")
      .is("deleted_at", null),
    supabase.from("evaluations").select("employee_id").eq("cycle_id", cycleId).eq("eval_type", "supervisor").is("deleted_at", null),
  ]);
  const withEvaluation = new Set(((evaluations ?? []) as { employee_id: string }[]).map((e) => e.employee_id));
  return planCycleEvaluations((profiles ?? []) as PlanProfile[], cycle, withEvaluation);
}

export interface GenerateOutcome {
  summary: CyclePlanSummary;
  created: number;
  errors: string[];
  dryRun: boolean;
}

const BATCH_SIZE = 100;

export async function generateCycleEvaluations(supabase: SupabaseClient, cycleId: string, dryRun: boolean): Promise<GenerateOutcome | null> {
  const plan = await loadCyclePlan(supabase, cycleId);
  if (!plan) return null;
  const summary = summarisePlan(plan);
  if (dryRun) return { summary, created: 0, errors: [], dryRun: true };

  let created = 0;
  const errors: string[] = [];
  for (let i = 0; i < plan.toCreate.length; i += BATCH_SIZE) {
    const batch = plan.toCreate.slice(i, i + BATCH_SIZE).map((p) => ({ employee_id: p.id, cycle_id: cycleId, eval_type: "supervisor", state: "draft" }));
    const { error, count } = await supabase.from("evaluations").insert(batch, { count: "exact" });
    if (error) errors.push(`batch ${i / BATCH_SIZE + 1}: ${error.message}`);
    else created += count ?? batch.length;
  }
  return { summary, created, errors, dryRun: false };
}
