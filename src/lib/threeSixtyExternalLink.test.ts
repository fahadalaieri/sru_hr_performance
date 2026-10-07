import { describe, it, expect } from "vitest";
import { evaluateExternalLinkAccess } from "./threeSixtyExternalLink";

const external = { raterEmployeeId: null, externalRaterEmail: "guest@example.org", status: "pending" as const, cycleStatus: "active" as const };

describe("evaluateExternalLinkAccess", () => {
  it("admits a pending external assignment in an active cycle", () => {
    expect(evaluateExternalLinkAccess(external)).toEqual({ ok: true });
  });

  it("still admits a submitted external assignment while the cycle is active, so the rater can review", () => {
    expect(evaluateExternalLinkAccess({ ...external, status: "submitted" })).toEqual({ ok: true });
  });

  it("refuses a token that belongs to an internal (employee) assignment", () => {
    expect(evaluateExternalLinkAccess({ ...external, raterEmployeeId: "emp-1", externalRaterEmail: null })).toEqual({ ok: false, reason: "not_external" });
  });

  it("refuses an excluded assignment", () => {
    expect(evaluateExternalLinkAccess({ ...external, status: "excluded" })).toEqual({ ok: false, reason: "excluded" });
  });

  it("treats the link as expired once the cycle is closed", () => {
    expect(evaluateExternalLinkAccess({ ...external, cycleStatus: "closed" })).toEqual({ ok: false, reason: "cycle_not_active" });
  });

  it("treats the link as not yet open while the cycle is still a draft", () => {
    expect(evaluateExternalLinkAccess({ ...external, cycleStatus: "draft" })).toEqual({ ok: false, reason: "cycle_not_active" });
  });
});
