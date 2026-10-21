import { describe, expect, it } from "vitest";
import { daysUntil, deadlineForState, isOverdue, reminderKind } from "./evaluationDeadlines";

const cycle = { deadline_submit: "2026-03-31", deadline_supervisor: "2026-04-15", deadline_recommend: "2026-04-30", deadline_approve: "2026-05-15" };

describe("deadlineForState", () => {
  it("maps each lifecycle state to the phase deadline that governs it", () => {
    expect(deadlineForState(cycle, "draft")).toBe("2026-03-31");
    expect(deadlineForState(cycle, "submitted")).toBe("2026-04-15");
    expect(deadlineForState(cycle, "supervisor_reviewed")).toBe("2026-04-30");
    expect(deadlineForState(cycle, "manager_recommended")).toBe("2026-04-30");
    expect(deadlineForState(cycle, "committee_reviewed")).toBe("2026-05-15");
    expect(deadlineForState(cycle, "approved")).toBe("2026-05-15");
    expect(deadlineForState(cycle, "finalized")).toBeNull();
  });
  it("a cycle without deadlines has none", () => {
    expect(deadlineForState({ deadline_submit: null, deadline_supervisor: null, deadline_recommend: null, deadline_approve: null }, "draft")).toBeNull();
  });
});

describe("reminderKind", () => {
  it("week at 2–7 days, day at 0–1, overdue after, nothing earlier", () => {
    expect(reminderKind("2026-03-31", "2026-03-20")).toBeNull();
    expect(reminderKind("2026-03-31", "2026-03-24")).toBe("week");
    expect(reminderKind("2026-03-31", "2026-03-29")).toBe("week");
    expect(reminderKind("2026-03-31", "2026-03-30")).toBe("day");
    expect(reminderKind("2026-03-31", "2026-03-31")).toBe("day");
    expect(reminderKind("2026-03-31", "2026-04-01")).toBe("overdue");
    expect(reminderKind(null, "2026-04-01")).toBeNull();
  });
  it("daysUntil ignores time zones and month boundaries", () => {
    expect(daysUntil("2026-03-01", "2026-02-28")).toBe(1);
    expect(daysUntil("2026-01-01", "2026-01-02")).toBe(-1);
    expect(isOverdue("2026-01-01", "2026-01-02")).toBe(true);
    expect(isOverdue("2026-01-02", "2026-01-02")).toBe(false);
  });
});
