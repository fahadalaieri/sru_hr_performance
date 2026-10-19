import { describe, expect, it } from "vitest";
import { assessEligibility, hireCutoff, planCycleEvaluations, type EligibilityProfile } from "./cycleEligibility";

const cycle = { start_date: "2026-01-01", end_date: "2026-12-31" };
const base: EligibilityProfile = { id: "p", status: "active", approval_status: "approved", org_unit_id: "u", supervisor_id: "s", hire_date: null };

describe("hireCutoff", () => {
  it("is three months before the cycle midpoint", () => {
    // midpoint of 2026 ≈ 2026-07-02 → cutoff 2026-04-02
    expect(hireCutoff(cycle)).toBe("2026-04-02");
  });
});

describe("assessEligibility", () => {
  it("a placed, active, approved employee without a hire date is eligible", () => {
    expect(assessEligibility(base, cycle)).toEqual([]);
  });
  it("names every missing piece, not just the first", () => {
    expect(assessEligibility({ ...base, status: "on_leave", org_unit_id: null, supervisor_id: null }, cycle)).toEqual(["not_active", "no_org_unit", "no_supervisor"]);
    expect(assessEligibility({ ...base, status: "terminated", approval_status: "pending" }, cycle)).toEqual(["not_active", "not_approved"]);
  });
  it("a hire date after the cutoff excludes; on or before includes", () => {
    expect(assessEligibility({ ...base, hire_date: "2026-04-03" }, cycle)).toEqual(["hired_too_late"]);
    expect(assessEligibility({ ...base, hire_date: "2026-04-02" }, cycle)).toEqual([]);
    expect(assessEligibility({ ...base, hire_date: "2019-09-01" }, cycle)).toEqual([]);
  });
});

describe("planCycleEvaluations", () => {
  it("splits into existing, to-create and not-ready", () => {
    const profiles: EligibilityProfile[] = [
      { ...base, id: "a" },
      { ...base, id: "b" },
      { ...base, id: "c", supervisor_id: null },
      { ...base, id: "d", status: "terminated" },
    ];
    const plan = planCycleEvaluations(profiles, cycle, new Set(["a"]));
    expect(plan.existing.map((p) => p.id)).toEqual(["a"]);
    expect(plan.toCreate.map((p) => p.id)).toEqual(["b"]);
    expect(plan.notReady.map((n) => [n.profile.id, n.reasons])).toEqual([["c", ["no_supervisor"]], ["d", ["not_active"]]]);
  });
});
