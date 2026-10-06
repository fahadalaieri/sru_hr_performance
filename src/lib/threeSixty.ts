/**
 * Pure logic for the "التقييم الدائري" (360 Review) module -- kept free of
 * Supabase/Next.js so it is directly unit-testable (see threeSixty.test.ts),
 * matching this project's convention of extracting shared business rules
 * (e.g. `recruitmentPlan.ts`, `vacancyStatus.ts`, `orgStructurePositions.ts`)
 * rather than inlining them once inside a Server Component/Action.
 *
 * The scoring pipeline (2026-09-04 rewrite, literal rules given directly by
 * the project owner) is a chain of small, composable functions rather than
 * one large one, so each rule is independently testable:
 *
 *   raw assignments --excludeByTenure--> eligible assignments
 *   eligible assignments + responses --computeItemGroupAverages-->
 *     per (item, rater group) averages
 *   --computeCompetencyGroupScores--> per (competency, rater group) scores
 *   --computeCompetencyOfficialScores (combineWeighted by group_weight_pct)-->
 *     per-competency official score
 *   --computeOverallScore (combineWeighted by weight_pct)--> overall score
 *
 * `combineWeighted` is the ONE weighted-combine implementation shared by the
 * competency, overall, and item-ranking steps -- not three near-copies.
 */

export type ThreeSixtyCycleStatus = "draft" | "active" | "closed";
export const threeSixtyCycleStatusLabels: Record<ThreeSixtyCycleStatus, string> = {
  draft: "مسودة",
  active: "نشطة",
  closed: "مغلقة",
};

export type ThreeSixtyAssignmentStatus = "pending" | "submitted" | "excluded";
export const threeSixtyAssignmentStatusLabels: Record<ThreeSixtyAssignmentStatus, string> = {
  pending: "بانتظار التعبئة",
  submitted: "تم التعبئة",
  excluded: "مستبعد",
};

/**
 * A rater may write (save/edit) responses only while the assignment is still
 * `pending`. `submitted` is final — the answers have been counted — and
 * `excluded` never accepts answers. The same rule is enforced in Postgres by
 * `three_sixty_responses_insert`/`_update` (20261006000001); this helper is
 * the application-layer mirror used by both the internal and the external
 * (token) save actions so the two paths cannot drift apart.
 */
export function canWriteThreeSixtyResponses(status: ThreeSixtyAssignmentStatus): boolean {
  return status === "pending";
}

export type ThreeSixtyNominationStatus = "draft" | "submitted" | "approved" | "returned";
export const threeSixtyNominationStatusLabels: Record<ThreeSixtyNominationStatus, string> = {
  draft: "مسودة",
  submitted: "بانتظار اعتماد الرئيس المباشر",
  approved: "معتمدة",
  returned: "أُعيدت لتعديل",
};

/** The relationship_code this project's template always uses for self-assessment (see generateThreeSixtyFixedAssignments). */
export const SELF_RELATIONSHIP_CODE = "self";

/**
 * 2026-09-06: a rater in `three_sixty_nominations`/`three_sixty_assignments`
 * is now either a real employee (`raterEmployeeId`) or an external person
 * with no profile at all (`externalRaterEmail`) -- "اسمح للخارجي بالإجابة
 * على الاستبيان من خلال الايميل الخاص به من غير دخول على النظام"، scoped to
 * the "مستفيد/عميل" group specifically (`allows_external_rater`, migration
 * 20260906000002). `rater_employee_id` is NULL for every external row, and
 * a plain `${code}::${raterEmployeeId}` reconciliation key (the shape
 * `nominate/actions.ts`/`assignmentCreation.ts` already used) would
 * silently collapse every external nominee in the same group onto one
 * identical key -- caught while building this, not live, since NULL !== NULL
 * for plain string comparison too, but string-templating NULL into a
 * shared key is a distinct, easy-to-miss trap. Email (lowercased/trimmed)
 * is the stable identity for an external row instead.
 */
export interface NominationIdentity {
  raterEmployeeId: string | null;
  externalRaterEmail: string | null;
}

export function nominationIdentityKey({ raterEmployeeId, externalRaterEmail }: NominationIdentity): string {
  return raterEmployeeId ?? `external:${(externalRaterEmail ?? "").trim().toLowerCase()}`;
}

export interface ThreeSixtyRaterGroup {
  relationshipCode: string;
  nameAr: string;
  groupWeightPct: number;
  minRatersInGroup: number;
  maxRatersInGroup: number | null;
  shownSeparately: boolean;
  employeeMayNominate: boolean;
}

export interface ThreeSixtyItem {
  id: string;
  itemCode: string;
  competencyId: string;
  itemType: "rating" | "open_text";
  raterGroups: string[];
  required: boolean;
  reverseScored: boolean;
  scaleCode: string | null;
  displayOrder: number;
  /** null = level-agnostic (e.g. the open-text item), always shown regardless of the subject's resolved level. */
  behavioralLevel: BehavioralLevel | null;
}

export interface ThreeSixtyCompetency {
  id: string;
  nameAr: string;
  weightPct: number | null;
}

/**
 * 2026-09-04: "نفس الجدارات الأساسية لكن بمستويات مختلفة" -- items now vary
 * by behavioral level (basic/practitioner/advanced/professional), matching
 * the seniority of the employee actually being rated rather than one fixed
 * level for everyone (see migration 20260904000003's header). `practitioner`
 * is the documented fallback when the subject's job title has no
 * `job_title_competencies.required_level` on record for a given competency
 * -- most job titles today don't (checked directly against production
 * before building this), so this fallback is load-bearing, not an edge case.
 */
export type BehavioralLevel = "basic" | "practitioner" | "advanced" | "professional";
export const DEFAULT_BEHAVIORAL_LEVEL: BehavioralLevel = "practitioner";

/**
 * 2026-09-05: "أضف الجدارات التخصصية الـ16 أيضًا" -- a 360 competency now
 * carries whether it applies to EVERYONE ("all", the 11 institutional ones)
 * or ONLY to a subject whose job title explicitly requires it ("specialized",
 * the 16 academic/innovation-track ones, see migration
 * 20260905000001's header). This is the real distinction between the two:
 * an "all" competency always resolves to a level (falling back to
 * `DEFAULT_BEHAVIORAL_LEVEL` when the job title has no explicit
 * requirement), while a "specialized" competency with no explicit
 * requirement is EXCLUDED from the subject's survey entirely, not defaulted
 * -- most job titles have no specialized-competency requirements at all
 * (checked directly against production before building this), and showing
 * every subject all 16 regardless of relevance would defeat the entire
 * point of "specialized".
 */
export type ThreeSixtyCompetencyScope = "all" | "specialized";

export interface ThreeSixtyCompetencySource {
  id: string;
  /** The real institutional competency this 360 competency was seeded from, or null if it has none (no per-job-title level data can ever apply, so an "all" competency with no source always falls back). */
  sourceCompetencyId: string | null;
  appliesTo: ThreeSixtyCompetencyScope;
}

export interface JobTitleCompetencyLevel {
  /** The REAL institutional competency id (competencies.id), matching ThreeSixtyCompetencySource.sourceCompetencyId -- not the 360 competency's own id. */
  competencyId: string;
  requiredLevel: BehavioralLevel;
}

/**
 * For each 360 competency, resolve whether it applies to a given subject
 * employee's job title and, if so, at which behavioral level. Returns a map
 * containing ONLY the competencies that apply -- an "all" competency always
 * appears (the job title's own required_level for its real institutional
 * counterpart if on record, else `fallback`), while a "specialized"
 * competency appears only when the job title has an explicit
 * `required_level` on record for it; otherwise it's simply absent from the
 * result, not defaulted.
 */
export function resolveThreeSixtyItemLevels(
  competencies: ThreeSixtyCompetencySource[],
  jobTitleLevels: JobTitleCompetencyLevel[],
  fallback: BehavioralLevel = DEFAULT_BEHAVIORAL_LEVEL
): Map<string, BehavioralLevel> {
  const levelBySourceCompetencyId = new Map(jobTitleLevels.map((l) => [l.competencyId, l.requiredLevel]));
  const result = new Map<string, BehavioralLevel>();
  for (const c of competencies) {
    const explicit = c.sourceCompetencyId ? levelBySourceCompetencyId.get(c.sourceCompetencyId) : undefined;
    if (explicit) {
      result.set(c.id, explicit);
    } else if (c.appliesTo === "all") {
      result.set(c.id, fallback);
    }
  }
  return result;
}

/**
 * Screen 3, level-aware: an item applies to this subject if it's either
 * level-agnostic (`behavioralLevel: null`, e.g. the open-text item) or its
 * own level matches the subject's resolved level for its competency. Applied
 * BEFORE `itemsForRelationship` -- the two filters are independent (one
 * narrows by who's rating, the other by who's being rated) and compose in
 * either order.
 */
export function itemsForSubjectLevel<T extends { competencyId: string; behavioralLevel: BehavioralLevel | null }>(
  items: T[],
  resolvedLevelByCompetencyId: Map<string, BehavioralLevel>
): T[] {
  return items.filter(
    (item) => item.behavioralLevel == null || item.behavioralLevel === resolvedLevelByCompetencyId.get(item.competencyId)
  );
}

/**
 * Screen 3 ("استبانة تعرض فقط العبارات التي تشمل فئته في rater_groups"):
 * an item is shown to a rater only if their own relationship_code for this
 * assignment appears in that item's `rater_groups` array. Sorted by
 * `display_order` so the questionnaire renders in the intended sequence.
 */
export function itemsForRelationship(items: ThreeSixtyItem[], relationshipCode: string): ThreeSixtyItem[] {
  return items
    .filter((item) => item.raterGroups.includes(relationshipCode))
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

export interface NominationCounts {
  /** relationship_code -> number of raters currently nominated in that group. */
  byGroup: Record<string, number>;
}

export interface NominationValidationInput {
  counts: NominationCounts;
  cycle: { minRaters: number; maxRaters: number | null };
  /** Only groups with `employeeMayNominate = true` are checked per-group. */
  raterGroups: ThreeSixtyRaterGroup[];
}

export interface NominationValidationResult {
  ok: boolean;
  /** Arabic-ready, one entry per violation -- see ThreeSixtyNominatePage.errorList. */
  errors: string[];
  totalNominated: number;
}

/**
 * Screen 2 ("ترشيح مقيّميه ضمن حد أدنى وأقصى"): validates a proposed
 * nomination set against both the cycle-wide bound (min_raters/max_raters)
 * and each nominate-able rater group's own bound
 * (min_raters_in_group/max_raters_in_group). Pure so the Server Action and
 * the client-side form can share the exact same rule instead of drifting.
 */
export function validateNominationCounts({
  counts,
  cycle,
  raterGroups,
}: NominationValidationInput): NominationValidationResult {
  const errors: string[] = [];
  const totalNominated = Object.values(counts.byGroup).reduce((sum, n) => sum + n, 0);

  if (totalNominated < cycle.minRaters) {
    errors.push(`العدد الإجمالي للمقيّمين (${totalNominated}) أقل من الحد الأدنى المطلوب (${cycle.minRaters}).`);
  }
  if (cycle.maxRaters != null && totalNominated > cycle.maxRaters) {
    errors.push(`العدد الإجمالي للمقيّمين (${totalNominated}) يتجاوز الحد الأقصى المسموح به (${cycle.maxRaters}).`);
  }

  for (const group of raterGroups) {
    if (!group.employeeMayNominate) continue;
    const count = counts.byGroup[group.relationshipCode] ?? 0;
    if (count < group.minRatersInGroup) {
      errors.push(`عدد "${group.nameAr}" (${count}) أقل من الحد الأدنى لهذه الفئة (${group.minRatersInGroup}).`);
    }
    if (group.maxRatersInGroup != null && count > group.maxRatersInGroup) {
      errors.push(`عدد "${group.nameAr}" (${count}) يتجاوز الحد الأقصى لهذه الفئة (${group.maxRatersInGroup}).`);
    }
  }

  return { ok: errors.length === 0, errors, totalNominated };
}

/**
 * A rating item's raw numeric value, adjusted for reverse-scoring. Reverse
 * scoring mirrors the value around the scale's midpoint
 * (`min + max - value`) so a "reverse scored" item (worded negatively) still
 * contributes in the same direction as every other item once averaged.
 */
export function reverseAdjustedValue(
  value: number,
  scaleMin: number,
  scaleMax: number,
  reverseScored: boolean
): number {
  return reverseScored ? scaleMin + scaleMax - value : value;
}

export interface AssignmentForTenure {
  id: string;
  relationshipCode: string;
  status: ThreeSixtyAssignmentStatus;
  monthsWorkedTogether: number | null;
}

/**
 * "يُستبعد آلياً كل تعيين months_worked_together أقل من min_months_together."
 * [استنتاج]: an assignment with an UNKNOWN tenure (months_worked_together is
 * NULL -- the field was only ever added for this rewrite, so most existing
 * data won't have it) is NOT excluded -- the rule only fires when a real
 * value is actually below the threshold, since there is no data to apply
 * the rule to otherwise.
 */
export function excludeByTenure<T extends AssignmentForTenure>(assignments: T[], minMonthsTogether: number): T[] {
  return assignments.filter((a) => a.monthsWorkedTogether == null || a.monthsWorkedTogether >= minMonthsTogether);
}

/**
 * Whether enough SCORING-group raters (group_weight_pct > 0 -- self/
 * supervisor are explicitly weight-0 "comparison only" groups per the
 * literal rule "الرئيس المباشر والتقييم الذاتي وزنهما صفر... ولا يدخلان
 * النتيجة") have completed their assignment for a result to be computed at
 * all. `eligibleAssignments` must already be tenure-filtered (via
 * `excludeByTenure`) and restricted to this one subject/cycle.
 */
export function meetsMinRatersGate(
  eligibleAssignments: { relationshipCode: string; status: ThreeSixtyAssignmentStatus }[],
  raterGroups: Pick<ThreeSixtyRaterGroup, "relationshipCode" | "groupWeightPct">[],
  minRaters: number
): { ok: boolean; completedCount: number } {
  const scoringCodes = new Set(raterGroups.filter((g) => g.groupWeightPct > 0).map((g) => g.relationshipCode));
  const completedCount = eligibleAssignments.filter(
    (a) => a.status === "submitted" && scoringCodes.has(a.relationshipCode)
  ).length;
  return { ok: completedCount >= minRaters, completedCount };
}

/**
 * 2026-09-05: the rich `three_sixty` module's own rating scale is whatever
 * the template configures (this app's default is 0-5, "behavior_freq_5" --
 * see 20260904000002's seed) -- not a 0-100 percentage like every other
 * evaluation method (`evaluation_scores.score`, and the old `feedback_360`
 * table's own `overall_score` before it). Feeding a raw 1-5 average
 * straight into `weightedCycleScore` alongside 0-100 percentages (see
 * `src/lib/threeSixtyEvaluationLink.ts`) would silently understate the 360
 * leg's real contribution -- caught live while verifying that exact wiring,
 * not assumed correct. `scaleMin`/`scaleMax` come from the counted rating
 * options actually configured for the cycle (never hardcoded), so this
 * works for any future scale, not just the current 0-5 one. Returns null
 * only for a degenerate scale (max <= min), since a percentage has no
 * meaning there.
 */
export function normalizeToPercent(value: number, scaleMin: number, scaleMax: number): number | null {
  if (scaleMax <= scaleMin) return null;
  return ((value - scaleMin) / (scaleMax - scaleMin)) * 100;
}

export interface WeightedEntry {
  score: number | null;
  weightPct: number;
}

/**
 * The one shared weighted-combine used for competency scores, the overall
 * score, and item ranking -- entries with `score: null` (no countable data)
 * are excluded from BOTH the numerator and the weight denominator instead
 * of being treated as zero, so a group/competency with no respondents
 * doesn't silently drag the result down. Returns null only when NO entry
 * has data (or all weights among entries with data are zero).
 */
export function combineWeighted(entries: WeightedEntry[]): number | null {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const entry of entries) {
    if (entry.score == null) continue;
    weightedSum += entry.score * entry.weightPct;
    totalWeight += entry.weightPct;
  }
  if (totalWeight <= 0) return null;
  return weightedSum / totalWeight;
}

export interface PreparedResponse {
  itemId: string;
  competencyId: string;
  relationshipCode: string;
  /** Already reverse-adjusted; null means "not counted" (e.g. a counted_in_score=false option) and must be excluded from the average, not treated as 0. */
  adjustedValue: number | null;
}

/** itemId -> relationshipCode -> average adjusted value (undefined if nobody in that group answered/counted). */
export function computeItemGroupAverages(responses: PreparedResponse[]): Map<string, Map<string, number>> {
  const sums = new Map<string, Map<string, { total: number; count: number }>>();
  for (const r of responses) {
    if (r.adjustedValue == null) continue;
    const byGroup = sums.get(r.itemId) ?? new Map<string, { total: number; count: number }>();
    const entry = byGroup.get(r.relationshipCode) ?? { total: 0, count: 0 };
    entry.total += r.adjustedValue;
    entry.count += 1;
    byGroup.set(r.relationshipCode, entry);
    sums.set(r.itemId, byGroup);
  }
  const result = new Map<string, Map<string, number>>();
  for (const [itemId, byGroup] of sums) {
    const averages = new Map<string, number>();
    for (const [code, { total, count }] of byGroup) {
      if (count > 0) averages.set(code, total / count);
    }
    result.set(itemId, averages);
  }
  return result;
}

/**
 * "نتيجة الجدارة = متوسط عباراتها": per (competency, rater group), the
 * average of that group's own item-averages for the competency's items
 * (only items that have data in that group -- a competency with zero
 * answered items in a group has no score for that group, not zero).
 */
export function computeCompetencyGroupScores(
  itemGroupAverages: Map<string, Map<string, number>>,
  items: Pick<ThreeSixtyItem, "id" | "competencyId">[]
): Map<string, Map<string, number>> {
  const sums = new Map<string, Map<string, { total: number; count: number }>>();
  for (const item of items) {
    const byGroup = itemGroupAverages.get(item.id);
    if (!byGroup) continue;
    for (const [code, avg] of byGroup) {
      const compByGroup = sums.get(item.competencyId) ?? new Map<string, { total: number; count: number }>();
      const entry = compByGroup.get(code) ?? { total: 0, count: 0 };
      entry.total += avg;
      entry.count += 1;
      compByGroup.set(code, entry);
      sums.set(item.competencyId, compByGroup);
    }
  }
  const result = new Map<string, Map<string, number>>();
  for (const [competencyId, byGroup] of sums) {
    const averages = new Map<string, number>();
    for (const [code, { total, count }] of byGroup) {
      if (count > 0) averages.set(code, total / count);
    }
    result.set(competencyId, averages);
  }
  return result;
}

/** "تُحسب نتيجة كل فئة على حدة، ثم تُجمع بأوزان group_weight_pct." -- the official per-competency score, combining every rater group's own competency score by its weight. */
export function computeCompetencyOfficialScores(
  competencyGroupScores: Map<string, Map<string, number>>,
  raterGroups: Pick<ThreeSixtyRaterGroup, "relationshipCode" | "groupWeightPct">[]
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  for (const [competencyId, byGroup] of competencyGroupScores) {
    const entries: WeightedEntry[] = raterGroups.map((g) => ({
      score: byGroup.get(g.relationshipCode) ?? null,
      weightPct: g.groupWeightPct,
    }));
    result.set(competencyId, combineWeighted(entries));
  }
  return result;
}

/** "النتيجة الكلية = مجموع الجدارات بأوزان weight_pct." */
export function computeOverallScore(
  competencyOfficialScores: Map<string, number | null>,
  competencies: Pick<ThreeSixtyCompetency, "id" | "weightPct">[]
): number | null {
  const entries: WeightedEntry[] = competencies.map((c) => ({
    score: competencyOfficialScores.get(c.id) ?? null,
    weightPct: c.weightPct ?? 0,
  }));
  return combineWeighted(entries);
}

export interface CompetencyGap {
  competencyId: string;
  nameAr: string;
  selfScore: number;
  othersScore: number;
  gap: number;
}

/**
 * "فجوة التقييم الذاتي عن متوسط الآخرين لكل جدارة، مع إبراز أكبر ثلاث فجوات."
 * A competency with no self-assessment data, or no official (others') score,
 * is skipped -- a gap can't be computed without both sides.
 */
export function computeSelfGaps(
  competencyGroupScores: Map<string, Map<string, number>>,
  competencyOfficialScores: Map<string, number | null>,
  competencies: ThreeSixtyCompetency[],
  selfRelationshipCode: string = SELF_RELATIONSHIP_CODE
): CompetencyGap[] {
  const gaps: CompetencyGap[] = [];
  for (const c of competencies) {
    const selfScore = competencyGroupScores.get(c.id)?.get(selfRelationshipCode);
    const othersScore = competencyOfficialScores.get(c.id);
    if (selfScore == null || othersScore == null) continue;
    gaps.push({ competencyId: c.id, nameAr: c.nameAr, selfScore, othersScore, gap: selfScore - othersScore });
  }
  return gaps.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 3);
}

export interface ItemScore {
  itemId: string;
  textAr: string;
  competencyId: string;
  score: number;
}

export interface RankableItem {
  id: string;
  textAr: string;
  competencyId: string;
}

/**
 * Official per-item score (same weighted-combine-by-group as competencies),
 * for "أعلى ثلاث عبارات وأدنى ثلاث عبارات" -- ranked across the WHOLE
 * survey, not per competency. Items with no countable data anywhere are
 * excluded from ranking entirely, never padded with a fake 0 entry.
 */
export function rankItems(
  itemGroupAverages: Map<string, Map<string, number>>,
  items: RankableItem[],
  raterGroups: Pick<ThreeSixtyRaterGroup, "relationshipCode" | "groupWeightPct">[]
): { top: ItemScore[]; bottom: ItemScore[] } {
  const scored: ItemScore[] = [];
  for (const item of items) {
    const byGroup = itemGroupAverages.get(item.id);
    const entries: WeightedEntry[] = raterGroups.map((g) => ({
      score: byGroup?.get(g.relationshipCode) ?? null,
      weightPct: g.groupWeightPct,
    }));
    const score = combineWeighted(entries);
    if (score != null) scored.push({ itemId: item.id, textAr: item.textAr, competencyId: item.competencyId, score });
  }
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  return { top: sorted.slice(0, 3), bottom: sorted.slice(-3).reverse() };
}

/** Fisher-Yates shuffle -- `rng` is injectable so tests can be deterministic; defaults to Math.random for real use (screens 4/5's "بترتيب عشوائي" pooled open-text list). */
export function shuffleOpenTextAnswers(texts: string[], rng: () => number = Math.random): string[] {
  const result = [...texts];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface AssignmentForCompletion {
  relationshipCode: string;
  status: ThreeSixtyAssignmentStatus;
}

export interface GroupCompletionStat {
  relationshipCode: string;
  total: number;
  submitted: number;
}

/** Per-rater-group submitted/total counts, from a flat assignment list (one cycle, one subject). */
export function groupCompletionStats(assignments: AssignmentForCompletion[]): GroupCompletionStat[] {
  const map = new Map<string, GroupCompletionStat>();
  for (const a of assignments) {
    if (a.status === "excluded") continue;
    const entry = map.get(a.relationshipCode) ?? { relationshipCode: a.relationshipCode, total: 0, submitted: 0 };
    entry.total += 1;
    if (a.status === "submitted") entry.submitted += 1;
    map.set(a.relationshipCode, entry);
  }
  return [...map.values()];
}

/**
 * Screens 4/5 anonymity rule: a rater group's own breakdown is shown
 * separately ONLY when the group is flagged `shown_separately` AND enough
 * raters in it have actually submitted to preserve k-anonymity (at least
 * `min_raters_in_group`) -- otherwise showing "the one peer who rated you"
 * as its own row would de-anonymize that single respondent. Groups that
 * don't clear the bar are folded into the overall aggregate instead of
 * being silently dropped. This governs DISPLAY only -- the official
 * competency/overall score above still incorporates a below-threshold
 * group's real numbers, it just isn't shown as its own line.
 */
export function visibleGroupBreakdown(
  raterGroups: ThreeSixtyRaterGroup[],
  stats: GroupCompletionStat[]
): { visible: GroupCompletionStat[]; folded: GroupCompletionStat[] } {
  const groupByCode = new Map(raterGroups.map((g) => [g.relationshipCode, g]));
  const visible: GroupCompletionStat[] = [];
  const folded: GroupCompletionStat[] = [];
  for (const stat of stats) {
    const group = groupByCode.get(stat.relationshipCode);
    if (group?.shownSeparately && stat.submitted >= group.minRatersInGroup) {
      visible.push(stat);
    } else {
      folded.push(stat);
    }
  }
  return { visible, folded };
}
