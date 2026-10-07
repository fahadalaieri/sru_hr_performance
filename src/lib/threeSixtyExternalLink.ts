import type { ThreeSixtyAssignmentStatus, ThreeSixtyCycleStatus } from "@/lib/threeSixty";

export interface ExternalLinkSubject {
  raterEmployeeId: string | null;
  externalRaterEmail: string | null;
  status: ThreeSixtyAssignmentStatus;
  cycleStatus: ThreeSixtyCycleStatus;
}

export type ExternalLinkAccess =
  | { ok: true }
  | { ok: false; reason: "not_external" | "excluded" | "cycle_not_active" };

/**
 * Whether a bare `access_token` may open the public (no-login) 360 survey.
 * `access_token` is generated for EVERY assignment row (20260906000002), so
 * the public path must itself refuse tokens of internal (employee) raters --
 * those are answered behind login, and a leaked internal token must not
 * become a second, unauthenticated way in. The link also lives only as long
 * as its cycle is `active`: a draft cycle has not opened, a closed one has
 * been scored, and either way the bearer link is spent. A submitted
 * assignment stays viewable (read-only, enforced separately) while the cycle
 * is active so the rater can review what they sent.
 */
export function evaluateExternalLinkAccess(a: ExternalLinkSubject): ExternalLinkAccess {
  if (a.raterEmployeeId !== null || a.externalRaterEmail === null) return { ok: false, reason: "not_external" };
  if (a.status === "excluded") return { ok: false, reason: "excluded" };
  if (a.cycleStatus !== "active") return { ok: false, reason: "cycle_not_active" };
  return { ok: true };
}
