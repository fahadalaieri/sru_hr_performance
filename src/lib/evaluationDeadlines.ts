import type { EvaluationState } from "./vpra";

/**
 * Cycle phase deadlines (20261021000002) and the reminder calendar built on
 * them (phase 2 item 7, owner rule 2026-10-21: four optional deadlines per
 * cycle; a reminder a week before, a day before, and once overdue).
 * Pure — the reminder runner and the pages both read these.
 */
export interface CycleDeadlines {
  deadline_submit: string | null;
  deadline_supervisor: string | null;
  deadline_recommend: string | null;
  deadline_approve: string | null;
}

export const DEADLINE_FIELDS = ["deadline_submit", "deadline_supervisor", "deadline_recommend", "deadline_approve"] as const;
export type DeadlineField = (typeof DEADLINE_FIELDS)[number];

/** Which deadline governs an evaluation sitting in `state` (null: none applies). */
export function deadlineFieldForState(state: EvaluationState): DeadlineField | null {
  switch (state) {
    case "draft":
      return "deadline_submit";
    case "submitted":
      return "deadline_supervisor";
    case "supervisor_reviewed":
    case "manager_recommended":
      return "deadline_recommend";
    case "committee_reviewed":
    case "approved":
      return "deadline_approve";
    default:
      return null;
  }
}

export function deadlineForState(cycle: CycleDeadlines, state: EvaluationState): string | null {
  const field = deadlineFieldForState(state);
  return field ? cycle[field] : null;
}

export type ReminderKind = "week" | "day" | "overdue";

/** Whole days from `today` to `deadline` (both YYYY-MM-DD); negative when past. */
export function daysUntil(deadline: string, today: string): number {
  const d = Date.UTC(+deadline.slice(0, 4), +deadline.slice(5, 7) - 1, +deadline.slice(8, 10));
  const t = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  return Math.round((d - t) / 86_400_000);
}

/**
 * The reminder due today for a deadline, if any: "week" when 2–7 days remain,
 * "day" when 0–1 remain, "overdue" once it has passed. Sent at most once per
 * kind per evaluation per recipient (the runner deduplicates by type).
 */
export function reminderKind(deadline: string | null, today: string): ReminderKind | null {
  if (!deadline) return null;
  const days = daysUntil(deadline, today);
  if (days < 0) return "overdue";
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  return null;
}

export function isOverdue(deadline: string | null, today: string): boolean {
  return deadline != null && daysUntil(deadline, today) < 0;
}
