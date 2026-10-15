import { describe, expect, it } from "vitest";
import { reviewApprovalSchema } from "./approvalSchema";

describe("reviewApprovalSchema", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";

  it("accepts a bare decision", () => {
    expect(reviewApprovalSchema.safeParse({ profileId: id, decision: "approved" }).success).toBe(true);
  });

  it("turns empty placement strings into undefined", () => {
    const r = reviewApprovalSchema.safeParse({ profileId: id, decision: "approved", orgUnitId: "", jobTitleId: "", supervisorId: "" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.orgUnitId).toBeUndefined();
      expect(r.data.jobTitleId).toBeUndefined();
      expect(r.data.supervisorId).toBeUndefined();
    }
  });

  it("keeps real placement ids", () => {
    const r = reviewApprovalSchema.safeParse({ profileId: id, decision: "approved", orgUnitId: other, supervisorId: other });
    expect(r.success && r.data.orgUnitId).toBe(other);
  });

  it("rejects a supervisor equal to the profile", () => {
    expect(reviewApprovalSchema.safeParse({ profileId: id, decision: "approved", supervisorId: id }).success).toBe(false);
  });

  it("rejects a non-uuid placement id", () => {
    expect(reviewApprovalSchema.safeParse({ profileId: id, decision: "approved", orgUnitId: "nope" }).success).toBe(false);
  });
});
