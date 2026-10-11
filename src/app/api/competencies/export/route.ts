import { NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { buildExportResponse, parseExportFormat, selectColumns } from "@/lib/exportResponse";
import { COMPETENCY_EXPORT_COLUMNS, type CompetencyExportColumn } from "@/lib/competencyExportColumns";
import { createClient } from "@/lib/supabase/server";
import { behavioralLevelOrder } from "@/lib/competencyFramework";
import { behavioralLevelLabels } from "@/lib/data/competencies";
import { requireExportAccess, type ExportGate } from "@/lib/exportAuth";

// Excluded from src/proxy.ts's matcher (which skips /api entirely) -- no
// locale/session-refresh happens automatically here; createClient() still
// works since Route Handlers read the request's cookies directly. Mirrors
// every other export route in this app (e.g. /api/recruitment/requests/export).
//
// Rows are re-fetched here through the caller's own RLS-respecting client --
// nothing about which pillars/domains/competencies exist is trusted from the
// client. One row per competency (the tree flattened), the same shape every
// other export in this app already uses.
/**
 * Export gate = the permission that shows /competencies on screen (same gate the page uses).
 * See requireExportAccess for the product rule this encodes.
 */
const EXPORT_GATE: ExportGate = [{ area: "competencyFramework", minLevel: "view" }];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const access = await requireExportAccess(supabase, EXPORT_GATE);
  if (!access.ok) return access.response;

  const [
    { data: pillarsData },
    { data: domainsData },
    { data: competenciesData },
    { data: levelsData },
    { data: jobFamiliesData },
    { data: classificationsData },
  ] = await Promise.all([
    supabase.from("competency_pillars").select("id, name_ar"),
    supabase.from("competency_domains").select("id, pillar_id, name_ar"),
    supabase
      .from("competencies")
      .select("id, domain_id, name_ar, classification_id, definition_ar, expected_impact_ar, job_family_id")
      .is("deleted_at", null)
      .order("name_ar"),
    supabase.from("competency_levels").select("competency_id, level, behavior_ar"),
    supabase.from("job_families").select("id, name_ar"),
    supabase.from("competency_classifications").select("id, name_ar"),
  ]);

  const pillarNameById = new Map((pillarsData ?? []).map((p) => [p.id as string, p.name_ar as string]));
  const domainById = new Map(
    (domainsData ?? []).map((d) => [d.id as string, { name_ar: d.name_ar as string, pillar_id: d.pillar_id as string }])
  );
  const jobFamilyNameById = new Map((jobFamiliesData ?? []).map((f) => [f.id as string, f.name_ar as string]));
  const classificationNameById = new Map((classificationsData ?? []).map((c) => [c.id as string, c.name_ar as string]));

  const levelTextByCompetency = new Map<string, Partial<Record<string, string>>>();
  for (const row of (levelsData ?? []) as Array<{ competency_id: string; level: string; behavior_ar: string }>) {
    const existing = levelTextByCompetency.get(row.competency_id) ?? {};
    existing[row.level] = row.behavior_ar;
    levelTextByCompetency.set(row.competency_id, existing);
  }

  const competencies = (competenciesData ?? []) as Array<{
    id: string;
    domain_id: string;
    name_ar: string;
    classification_id: string;
    definition_ar: string;
    expected_impact_ar: string;
    job_family_id: string | null;
  }>;

  const views = competencies.map((c) => {
    const domain = domainById.get(c.domain_id);
    const levels = levelTextByCompetency.get(c.id) ?? {};
    return {
      pillar: domain ? (pillarNameById.get(domain.pillar_id) ?? "") : "",
      domain: domain?.name_ar ?? "",
      name: c.name_ar,
      classification: classificationNameById.get(c.classification_id) ?? "",
      jobFamily: c.job_family_id ? (jobFamilyNameById.get(c.job_family_id) ?? "") : "",
      definition: c.definition_ar,
      expectedImpact: c.expected_impact_ar,
      basic: levels.basic ?? "",
      practitioner: levels.practitioner ?? "",
      advanced: levels.advanced ?? "",
      professional: levels.professional ?? "",
    };
  });

  const t = await getTranslations({ locale: "ar", namespace: "CompetenciesPage" });
  const columnLabels: Record<CompetencyExportColumn, string> = {
    pillar: t("exportColumnPillar"),
    domain: t("exportColumnDomain"),
    name: t("competencyNameArLabel"),
    classification: t("competencyClassificationLabel"),
    jobFamily: t("jobFamilyLabel"),
    definition: t("definitionArLabel"),
    expectedImpact: t("expectedImpactArLabel"),
    basic: behavioralLevelLabels.basic,
    practitioner: behavioralLevelLabels.practitioner,
    advanced: behavioralLevelLabels.advanced,
    professional: behavioralLevelLabels.professional,
  };

  const params = request.nextUrl.searchParams;
  const columns = selectColumns(COMPETENCY_EXPORT_COLUMNS, params.get("columns"));
  const wideColumns = new Set<CompetencyExportColumn>(["definition", "expectedImpact", ...behavioralLevelOrder]);

  return buildExportResponse({
    format: parseExportFormat(params.get("format")),
    sheetName: "إطار الجدارات",
    filenameBase: "competencies",
    headers: columns.map((c) => columnLabels[c]),
    rows: views.map((row) => columns.map((c) => row[c])),
    wideColumnIndexes: columns.map((c, i) => (wideColumns.has(c) ? i : -1)).filter((i) => i >= 0),
  });
}
