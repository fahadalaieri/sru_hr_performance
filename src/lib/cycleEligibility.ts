/**
 * Who gets an evaluation in a cycle (phase 2 item 5, owner rule 2026-10-19):
 *  - an active, approved employee with an org unit and a direct supervisor;
 *  - hired at least three months before the cycle's midpoint — applied only
 *    when a hire date is on record (the HR files loaded on 2026-10-15 carry
 *    none, so the rule switches itself on as hire dates arrive);
 *  - on-leave and terminated employees are out.
 * Anyone else is "not ready" with the reasons, so HR can fix the record
 * instead of silently getting an evaluation nobody can run.
 */
export type IneligibilityReason = "not_active" | "not_approved" | "no_org_unit" | "no_supervisor" | "hired_too_late";

export interface EligibilityProfile {
  id: string;
  status: string;
  approval_status: string;
  org_unit_id: string | null;
  supervisor_id: string | null;
  hire_date: string | null;
}

export interface EligibilityCycle {
  start_date: string;
  end_date: string;
}

export const HIRE_MONTHS_BEFORE_MIDPOINT = 3;

/** ISO date (YYYY-MM-DD) of the latest hire date still eligible for this cycle. */
export function hireCutoff(cycle: EligibilityCycle): string {
  const start = Date.UTC(+cycle.start_date.slice(0, 4), +cycle.start_date.slice(5, 7) - 1, +cycle.start_date.slice(8, 10));
  const end = Date.UTC(+cycle.end_date.slice(0, 4), +cycle.end_date.slice(5, 7) - 1, +cycle.end_date.slice(8, 10));
  const mid = new Date(start + (end - start) / 2);
  mid.setUTCMonth(mid.getUTCMonth() - HIRE_MONTHS_BEFORE_MIDPOINT);
  return mid.toISOString().slice(0, 10);
}

export function assessEligibility(profile: EligibilityProfile, cycle: EligibilityCycle): IneligibilityReason[] {
  const reasons: IneligibilityReason[] = [];
  if (profile.status !== "active") reasons.push("not_active");
  if (profile.approval_status !== "approved") reasons.push("not_approved");
  if (!profile.org_unit_id) reasons.push("no_org_unit");
  if (!profile.supervisor_id) reasons.push("no_supervisor");
  if (profile.hire_date && profile.hire_date > hireCutoff(cycle)) reasons.push("hired_too_late");
  return reasons;
}

export interface CyclePlan<P extends EligibilityProfile = EligibilityProfile> {
  /** Eligible and already carrying a supervisor evaluation in this cycle. */
  existing: P[];
  /** Eligible and still without one — what a generation run creates. */
  toCreate: P[];
  /** Not eligible, with why. */
  notReady: Array<{ profile: P; reasons: IneligibilityReason[] }>;
}

export function planCycleEvaluations<P extends EligibilityProfile>(
  profiles: P[],
  cycle: EligibilityCycle,
  employeeIdsWithEvaluation: ReadonlySet<string>
): CyclePlan<P> {
  const plan: CyclePlan<P> = { existing: [], toCreate: [], notReady: [] };
  for (const profile of profiles) {
    const reasons = assessEligibility(profile, cycle);
    if (reasons.length > 0) plan.notReady.push({ profile, reasons });
    else if (employeeIdsWithEvaluation.has(profile.id)) plan.existing.push(profile);
    else plan.toCreate.push(profile);
  }
  return plan;
}
