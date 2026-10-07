import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { isLocale, getDir, type Locale } from "@/i18n/config";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { ThreeSixtyExternalQuestionnaireForm } from "@/components/ThreeSixtyExternalQuestionnaireForm";
import type { BehavioralLevel, ThreeSixtyAssignmentStatus, ThreeSixtyCycleStatus } from "@/lib/threeSixty";
import { evaluateExternalLinkAccess } from "@/lib/threeSixtyExternalLink";
import { resolveApplicableThreeSixtyItems } from "@/lib/threeSixtyAssignmentItems";

/**
 * The public, no-login survey page for an external ("مستفيد/عميل") 360
 * rater -- reached only via the unguessable link an internal user copies
 * from `/three-sixty/nominate` (see that page's header comment on why
 * there's no automatic email yet). Deliberately OUTSIDE `(app)/` (a sibling
 * of `login`/`reset-password`, same as those), so `(app)/layout.tsx`'s
 * central auth gate never applies here -- there is no session to gate.
 */
export default async function ThreeSixtyExternalSurveyPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale: rawLocale, token } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : "ar";
  const t = await getTranslations("ThreeSixtyExternalPage");

  // Unauthenticated, service-role-backed page: cap how often one address can
  // probe it (fails open on an RPC error, same posture as `login`).
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rateOk = await checkRateLimit(`three_sixty_external:view:ip:${ip}`, 60, 15 * 60);

  const admin = createAdminClient();

  const { data: assignment } = rateOk
    ? await admin
        .from("three_sixty_assignments")
        .select(
          "id, subject_employee_id, relationship_code, status, cycle_id, rater_employee_id, external_rater_email, three_sixty_cycles(name_ar, status)"
        )
        .eq("access_token", token)
        .is("deleted_at", null)
        .maybeSingle()
    : { data: null };

  // Only an EXTERNAL rater's assignment in an ACTIVE cycle opens here -- an
  // internal rater's token, an excluded assignment, or a draft/closed cycle
  // all read as a dead link (see evaluateExternalLinkAccess).
  const cycleRow = assignment?.three_sixty_cycles as unknown as { name_ar: string; status: ThreeSixtyCycleStatus } | null;
  const access = assignment
    ? evaluateExternalLinkAccess({
        raterEmployeeId: assignment.rater_employee_id,
        externalRaterEmail: assignment.external_rater_email,
        status: assignment.status as ThreeSixtyAssignmentStatus,
        cycleStatus: cycleRow?.status ?? "closed",
      })
    : null;

  if (!rateOk || !assignment || !access || !access.ok) {
    const denial = !rateOk
      ? t("errorTooManyRequests")
      : access && !access.ok && access.reason === "cycle_not_active"
        ? t("errorLinkExpired")
        : t("errorInvalidLink");
    return (
      <main className="sru-auth-page" dir={getDir(locale)}>
        <div className="sru-auth-card">
          <div className="sru-auth-brand">
            <Image src="/sru-logo.png" alt="شعار جامعة سليمان الراجحي" width={100} height={52} />
            <h1>{t("title")}</h1>
          </div>
          <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{denial}</p>
        </div>
      </main>
    );
  }

  const cycle = assignment.three_sixty_cycles as unknown as { name_ar: string } | null;

  const [{ data: subjectProfile }, { data: itemTextRows }, { data: scaleOptionRows }, { data: responseRows }] = await Promise.all([
    admin.from("profiles").select("full_name_ar, job_title_id").eq("id", assignment.subject_employee_id).maybeSingle(),
    admin.from("three_sixty_items").select("id, text_ar, scale_code").is("deleted_at", null),
    admin.from("three_sixty_rating_scale_options").select("id, scale_code, option_code, label_ar, numeric_value").is("deleted_at", null).order("numeric_value"),
    admin.from("three_sixty_responses").select("item_id, option_id, numeric_value, text_value").eq("assignment_id", assignment.id),
  ]);

  // Service role bypasses RLS already, so this reads job_title_competencies
  // directly instead of the get_three_sixty_subject_levels RPC (which
  // requires a real auth.uid() this unauthenticated request never has) --
  // see threeSixtyAssignmentItems.ts's own comment.
  const { data: levelRows } = subjectProfile?.job_title_id
    ? await admin.from("job_title_competencies").select("competency_id, required_level").eq("job_title_id", subjectProfile.job_title_id)
    : { data: [] };

  const applicableItems = await resolveApplicableThreeSixtyItems(
    admin,
    assignment.relationship_code,
    ((levelRows ?? []) as { competency_id: string; required_level: BehavioralLevel }[]).map((r) => ({
      competencyId: r.competency_id,
      requiredLevel: r.required_level,
    }))
  );
  const textAndScaleByItemId = new Map((itemTextRows ?? []).map((i) => [i.id, { textAr: i.text_ar, scaleCode: i.scale_code }]));

  const optionsByScale = new Map<string, { id: string; optionCode: string; labelAr: string; numericValue: number }[]>();
  for (const o of scaleOptionRows ?? []) {
    const list = optionsByScale.get(o.scale_code) ?? [];
    list.push({ id: o.id, optionCode: o.option_code, labelAr: o.label_ar, numericValue: o.numeric_value });
    optionsByScale.set(o.scale_code, list);
  }

  const existingByItem = new Map(
    (responseRows ?? []).map((r) => [r.item_id, { optionId: r.option_id, numericValue: r.numeric_value, textValue: r.text_value }])
  );

  const readOnly = assignment.status !== "pending";

  return (
    <main className="sru-auth-page" dir={getDir(locale)} style={{ alignItems: "flex-start", paddingBlock: 40 }}>
      <div className="sru-auth-card" style={{ maxWidth: 820, width: "100%" }}>
        <div className="sru-auth-brand">
          <Image src="/sru-logo.png" alt="شعار جامعة سليمان الراجحي" width={100} height={52} />
          <h1>{t("title")}</h1>
          <p>
            {cycle?.name_ar} — {subjectProfile?.full_name_ar ?? "—"}
          </p>
        </div>

        {applicableItems.length === 0 ? (
          <p style={{ color: "var(--sru-muted)", fontSize: 13 }}>{t("errorNoItems")}</p>
        ) : (
          <ThreeSixtyExternalQuestionnaireForm
            token={token}
            readOnly={readOnly}
            items={applicableItems.map((item) => {
              const extra = textAndScaleByItemId.get(item.id);
              return {
                id: item.id,
                itemCode: item.itemCode,
                itemType: item.itemType,
                textAr: extra?.textAr ?? "",
                required: item.required,
                options: extra?.scaleCode ? optionsByScale.get(extra.scaleCode) ?? [] : [],
              };
            })}
            existing={Object.fromEntries(existingByItem)}
          />
        )}
      </div>
    </main>
  );
}
