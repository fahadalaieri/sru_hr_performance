"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { ExcelImportDialog, type ImportFieldSpec } from "@/components/ExcelImportDialog";
import { importOrgStructureExcel, type ImportResult } from "@/app/[locale]/(app)/admin/org-structure/import-actions";
import { ORG_STRUCTURE_IMPORT_COLUMNS } from "@/lib/importColumns";

const errorMessageKeys: Record<string, string> = {
  invalid_input: "importErrorInvalid",
  unauthenticated: "importErrorForbidden",
  forbidden: "importErrorForbidden",
  unknown: "importErrorUnknown",
};

/**
 * Employees + organisational-structure import, on the shared dialog
 * (2026-08-24).
 *
 * `templateHref`/`note` still let each page point at its own template and
 * wording: the Employees page uses an employees-only template, while the
 * org-structure and staffing pages keep the combined one. The action tolerates
 * either shape (the structure sheet is optional).
 *
 * The listed fields are the EMPLOYEE columns — the ones a caller actually
 * wants to choose between when re-importing a staff list. The structure
 * sheet's own columns (code, parent code, level) describe the tree's shape
 * rather than a record's attributes, so there is nothing meaningful to tick
 * or untick there; a column the dialog does not name is left exactly as the
 * file has it.
 */
export function ImportOrgStructureExcelForm({
  templateHref = "/templates/sru-org-structure-import-template.xlsx",
  note,
  triggerVariant,
}: {
  templateHref?: string;
  note?: string;
  triggerVariant?: "primary" | "secondary";
} = {}) {
  const t = useTranslations("OrgStructurePage");

  const fields: ImportFieldSpec[] = [
    { key: "employeeNumber", label: t("importFieldEmployeeNumber"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.employeeNumber, isKey: true },
    { key: "fullNameAr", label: t("importFieldNameAr"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.fullNameAr, isKey: true },
    { key: "fullNameEn", label: t("importFieldNameEn"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.fullNameEn },
    { key: "email", label: t("importFieldEmail"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.email },
    { key: "department", label: t("importFieldDepartment"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.department },
    { key: "positionAr", label: t("importFieldPosition"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.positionAr },
    { key: "role", label: t("importFieldRole"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.role },
    { key: "supervisorNumber", label: t("importFieldSupervisor"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.supervisorNumber },
    { key: "hireDate", label: t("importFieldHireDate"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.hireDate },
    { key: "qualification", label: t("importFieldQualification"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.qualification },
    { key: "educationSpeciality", label: t("importFieldSpeciality"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.educationSpeciality },
    { key: "dateOfBirth", label: t("importFieldDateOfBirth"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.dateOfBirth },
    { key: "mobile", label: t("importFieldMobile"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.mobile },
    { key: "maritalStatus", label: t("importFieldMaritalStatus"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.maritalStatus },
    { key: "gender", label: t("importFieldGender"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.gender },
    { key: "nationality", label: t("importFieldNationality"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.nationality },
    { key: "employeeCategory", label: t("importFieldEmployeeCategory"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.employeeCategory },
    { key: "insuranceCategory", label: t("importFieldInsuranceCategory"), columnLabel: ORG_STRUCTURE_IMPORT_COLUMNS.insuranceCategory },
  ];

  return (
    <ExcelImportDialog
      triggerLabel={t("importTriggerButton")}
      heading={t("importHeading")}
      subtitle={note ?? t("importNote")}
      templateHref={templateHref}
      templateLabel={t("downloadTemplateButton")}
      fields={fields}
      action={importOrgStructureExcel}
      pendingLabel={t("importing")}
      triggerVariant={triggerVariant}
      previewLabel={t("importPreviewButton")}
    >
      {(state: ImportResult | null) => <OrgStructureImportOutcome state={state} />}
    </ExcelImportDialog>
  );
}

function OrgStructureImportOutcome({ state }: { state: ImportResult | null }) {
  const t = useTranslations("OrgStructurePage");
  const router = useRouter();

  useEffect(() => {
    // A preview wrote nothing, so there is nothing to refresh.
    if (state?.status === "success" && !state.summary.dryRun) router.refresh();
  }, [state, router]);

  if (!state) return null;

  if (state.status === "error") {
    return (
      <p role="alert" className="sru-auth-alert error" style={{ marginTop: 10 }}>
        {t(errorMessageKeys[state.message] ?? "importErrorUnknown")}
      </p>
    );
  }

  const allErrors = [
    ...state.summary.employeeErrors,
    ...state.summary.roleErrors,
    ...state.summary.positionErrors,
    ...state.summary.assignmentErrors,
  ];

  const placement = state.summary;
  return (
    <div style={{ marginTop: 12, fontSize: 11.5 }}>
      {placement.dryRun ? (
        <p role="status" style={{ color: "var(--sru-purple)", marginBottom: 8 }}>
          {t("importPreviewSummary", {
            approved: placement.approvedCreated,
            pending: placement.pendingCreated,
            noEmail: placement.withoutEmail,
            roles: placement.rolesAssigned,
          })}
        </p>
      ) : (
        <>
          <p role="status" style={{ color: "var(--sru-success, #15803d)", marginBottom: 8 }}>
            {t("importSuccess", {
              employees: state.summary.employeesUpserted,
              roles: state.summary.rolesAssigned,
              levels: state.summary.levelsCreated,
              positions: state.summary.positionsUpserted,
              assignments: state.summary.assignmentsCreated,
            })}
          </p>
          {(placement.supervisorsLinked > 0 || placement.approvedCreated > 0 || placement.pendingCreated > 0) && (
            <p style={{ color: "var(--sru-muted)", marginBottom: 8 }}>
              {t("importSuccessPlacement", {
                linked: placement.supervisorsLinked,
                approved: placement.approvedCreated,
                pending: placement.pendingCreated,
              })}
            </p>
          )}
        </>
      )}
      {placement.unknownSupervisors.length > 0 && (
        <details style={{ marginBottom: 6 }}>
          <summary>{t("importUnknownSupervisors", { count: placement.unknownSupervisors.length })}</summary>
          <ul style={{ paddingInlineStart: 18, color: "var(--sru-muted)" }}>
            {placement.unknownSupervisors.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </details>
      )}
      {state.summary.corrections.length > 0 && (
        <details style={{ marginBottom: 6 }}>
          <summary>{t("importCorrections", { count: state.summary.corrections.length })}</summary>
          <ul style={{ paddingInlineStart: 18, color: "var(--sru-muted)" }}>
            {state.summary.corrections.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      )}
      {state.summary.unmatchedOrgUnits.length > 0 && (
        <details style={{ marginBottom: 6 }}>
          <summary>{t("importUnmatchedOrgUnits", { count: state.summary.unmatchedOrgUnits.length })}</summary>
          <ul style={{ paddingInlineStart: 18, color: "var(--sru-muted)" }}>
            {state.summary.unmatchedOrgUnits.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </details>
      )}
      {allErrors.length > 0 && (
        <details>
          <summary className="text-red-600">{t("importWarnings", { count: allErrors.length })}</summary>
          <ul style={{ paddingInlineStart: 18, color: "var(--sru-muted)" }}>
            {allErrors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
