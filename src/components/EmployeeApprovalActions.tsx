"use client";

import { useActionState, useEffect } from "react";
import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { reviewEmployeeApproval, type ReviewEmployeeApprovalState } from "@/app/[locale]/(app)/employees/actions";

export interface ApprovalOption {
  id: string;
  label: string;
}

/**
 * Approve/reject one pending employee-data submission (2026-07-25 approval
 * workflow). Since 2026-10-15 the approver can PLACE the employee in the same
 * step — org unit, official title, supervisor — because bulk-loaded and
 * SSO-created profiles arrive with whatever the source could resolve and the
 * approval screen is where the gap gets closed. Each select defaults to what
 * the profile already holds; leaving it there changes nothing.
 */
export function EmployeeApprovalActions({
  profileId,
  current,
  orgUnits,
  jobTitles,
  supervisors,
}: {
  profileId: string;
  current: { orgUnitId: string | null; jobTitleId: string | null; jobTitleHint: string | null; supervisorId: string | null };
  orgUnits: ApprovalOption[];
  jobTitles: ApprovalOption[];
  supervisors: ApprovalOption[];
}) {
  const t = useTranslations("EmployeesPage");
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ReviewEmployeeApprovalState, FormData>(reviewEmployeeApproval, null);

  useEffect(() => {
    if (state?.status === "success") router.refresh();
  }, [state, router]);

  const selectStyle = { fontSize: 11.5, maxWidth: 190 } as const;

  return (
    <form action={formAction} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <input type="hidden" name="profileId" value={profileId} />
      <select name="orgUnitId" defaultValue={current.orgUnitId ?? ""} aria-label={t("placementOrgUnit")} style={selectStyle}>
        <option value="">{t("placementKeep")}</option>
        {orgUnits.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
        <select name="jobTitleId" defaultValue={current.jobTitleId ?? ""} aria-label={t("placementJobTitle")} style={selectStyle}>
          <option value="">{t("placementKeep")}</option>
          {jobTitles.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        {current.jobTitleHint && !current.jobTitleId && (
          <span style={{ fontSize: 10.5, color: "var(--sru-muted)" }}>{t("placementTitleHint", { hint: current.jobTitleHint })}</span>
        )}
      </span>
      <select name="supervisorId" defaultValue={current.supervisorId ?? ""} aria-label={t("placementSupervisor")} style={selectStyle}>
        <option value="">{t("placementKeep")}</option>
        {supervisors
          .filter((o) => o.id !== profileId)
          .map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
      </select>
      <button type="submit" name="decision" value="approved" disabled={pending} className="sru-icon-action primary" title={t("approveButton")} aria-label={t("approveButton")}>
        <Check size={15} />
      </button>
      <button type="submit" name="decision" value="rejected" disabled={pending} className="sru-icon-action danger" title={t("rejectButton")} aria-label={t("rejectButton")}>
        <X size={15} />
      </button>
      {state?.status === "error" && (
        <span role="alert" style={{ color: "#b91c1c", fontSize: 10.5 }}>
          {t("reviewError")}
        </span>
      )}
    </form>
  );
}
