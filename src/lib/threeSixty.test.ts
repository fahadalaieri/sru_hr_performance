import { describe, it, expect } from "vitest";
import { canWriteThreeSixtyResponses } from "./threeSixty";
import {
  itemsForRelationship,
  validateNominationCounts,
  reverseAdjustedValue,
  excludeByTenure,
  meetsMinRatersGate,
  combineWeighted,
  normalizeToPercent,
  computeItemGroupAverages,
  computeCompetencyGroupScores,
  computeCompetencyOfficialScores,
  computeOverallScore,
  computeSelfGaps,
  rankItems,
  shuffleOpenTextAnswers,
  groupCompletionStats,
  visibleGroupBreakdown,
  resolveThreeSixtyItemLevels,
  itemsForSubjectLevel,
  nominationIdentityKey,
  type ThreeSixtyItem,
  type ThreeSixtyRaterGroup,
  type ThreeSixtyCompetency,
  type PreparedResponse,
} from "./threeSixty";

function item(overrides: Partial<ThreeSixtyItem>): ThreeSixtyItem {
  return {
    id: "i1",
    itemCode: "Q1",
    competencyId: "c1",
    itemType: "rating",
    raterGroups: ["peer"],
    required: true,
    reverseScored: false,
    scaleCode: "freq",
    displayOrder: 0,
    behavioralLevel: null,
    ...overrides,
  };
}

function raterGroup(overrides: Partial<ThreeSixtyRaterGroup>): ThreeSixtyRaterGroup {
  return {
    relationshipCode: "peer",
    nameAr: "زميل",
    groupWeightPct: 50,
    minRatersInGroup: 0,
    maxRatersInGroup: null,
    shownSeparately: false,
    employeeMayNominate: true,
    ...overrides,
  };
}

describe("itemsForRelationship", () => {
  it("keeps only items whose rater_groups includes the given relationship", () => {
    const items = [
      item({ id: "a", raterGroups: ["peer", "subordinate"], displayOrder: 2 }),
      item({ id: "b", raterGroups: ["supervisor"], displayOrder: 1 }),
      item({ id: "c", raterGroups: ["peer"], displayOrder: 1 }),
    ];
    const result = itemsForRelationship(items, "peer");
    expect(result.map((i) => i.id)).toEqual(["c", "a"]);
  });

  it("returns an empty list when nothing applies to the relationship", () => {
    const items = [item({ raterGroups: ["supervisor"] })];
    expect(itemsForRelationship(items, "peer")).toEqual([]);
  });

  it("sorts by display_order ascending", () => {
    const items = [
      item({ id: "z", displayOrder: 5 }),
      item({ id: "a", displayOrder: 1 }),
      item({ id: "m", displayOrder: 3 }),
    ];
    expect(itemsForRelationship(items, "peer").map((i) => i.id)).toEqual(["a", "m", "z"]);
  });
});

describe("validateNominationCounts", () => {
  const raterGroups = [
    raterGroup({ relationshipCode: "peer", nameAr: "زميل", minRatersInGroup: 2, maxRatersInGroup: 4 }),
    raterGroup({
      relationshipCode: "subordinate",
      nameAr: "مرؤوس",
      minRatersInGroup: 1,
      maxRatersInGroup: 3,
    }),
    // Not nominate-able -- e.g. supervisor is system-assigned -- must be
    // ignored by the per-group checks even if absent from `counts`.
    raterGroup({ relationshipCode: "supervisor", nameAr: "رئيس مباشر", employeeMayNominate: false, minRatersInGroup: 1 }),
  ];

  it("passes when every bound is satisfied", () => {
    const result = validateNominationCounts({
      counts: { byGroup: { peer: 3, subordinate: 1 } },
      cycle: { minRaters: 3, maxRaters: 8 },
      raterGroups,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.totalNominated).toBe(4);
  });

  it("fails when the overall total is below the cycle minimum", () => {
    const result = validateNominationCounts({
      counts: { byGroup: { peer: 2 } },
      cycle: { minRaters: 5, maxRaters: null },
      raterGroups,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("الحد الأدنى المطلوب"))).toBe(true);
  });

  it("fails when the overall total exceeds the cycle maximum", () => {
    const result = validateNominationCounts({
      counts: { byGroup: { peer: 4, subordinate: 3 } },
      cycle: { minRaters: 1, maxRaters: 5 },
      raterGroups,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("الحد الأقصى المسموح به"))).toBe(true);
  });

  it("fails when a nominate-able group is below its own minimum", () => {
    const result = validateNominationCounts({
      counts: { byGroup: { peer: 1, subordinate: 1 } },
      cycle: { minRaters: 1, maxRaters: null },
      raterGroups,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('"زميل"') && e.includes("الحد الأدنى لهذه الفئة"))).toBe(true);
  });

  it("fails when a nominate-able group exceeds its own maximum", () => {
    const result = validateNominationCounts({
      counts: { byGroup: { peer: 2, subordinate: 5 } },
      cycle: { minRaters: 1, maxRaters: null },
      raterGroups,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('"مرؤوس"') && e.includes("الحد الأقصى لهذه الفئة"))).toBe(true);
  });

  it("never checks a group the employee may not nominate for, even at zero", () => {
    const result = validateNominationCounts({
      counts: { byGroup: { peer: 2, subordinate: 1 } },
      cycle: { minRaters: 1, maxRaters: null },
      raterGroups,
    });
    expect(result.errors.some((e) => e.includes("رئيس مباشر"))).toBe(false);
  });
});

describe("reverseAdjustedValue", () => {
  it("returns the raw value when not reverse scored", () => {
    expect(reverseAdjustedValue(4, 1, 5, false)).toBe(4);
  });

  it("mirrors the value around the scale midpoint when reverse scored", () => {
    // scale 1..5: 1<->5, 2<->4, 3<->3
    expect(reverseAdjustedValue(1, 1, 5, true)).toBe(5);
    expect(reverseAdjustedValue(5, 1, 5, true)).toBe(1);
    expect(reverseAdjustedValue(3, 1, 5, true)).toBe(3);
  });
});

describe("excludeByTenure", () => {
  it("excludes an assignment whose real tenure is below the minimum", () => {
    const result = excludeByTenure(
      [
        { id: "a", relationshipCode: "peer", status: "submitted", monthsWorkedTogether: 2 },
        { id: "b", relationshipCode: "peer", status: "submitted", monthsWorkedTogether: 6 },
      ],
      3
    );
    expect(result.map((a) => a.id)).toEqual(["b"]);
  });

  it("does NOT exclude an assignment with unknown (null) tenure -- the rule only fires on a real below-threshold value", () => {
    const result = excludeByTenure(
      [{ id: "a", relationshipCode: "peer", status: "submitted", monthsWorkedTogether: null }],
      3
    );
    expect(result.map((a) => a.id)).toEqual(["a"]);
  });

  it("keeps an assignment exactly at the minimum", () => {
    const result = excludeByTenure(
      [{ id: "a", relationshipCode: "peer", status: "submitted", monthsWorkedTogether: 3 }],
      3
    );
    expect(result.map((a) => a.id)).toEqual(["a"]);
  });
});

describe("meetsMinRatersGate", () => {
  const raterGroups = [
    { relationshipCode: "peer", groupWeightPct: 50 },
    { relationshipCode: "subordinate", groupWeightPct: 50 },
    { relationshipCode: "self", groupWeightPct: 0 },
    { relationshipCode: "supervisor", groupWeightPct: 0 },
  ];

  it("counts only submitted assignments in scoring (weight > 0) groups", () => {
    const gate = meetsMinRatersGate(
      [
        { relationshipCode: "peer", status: "submitted" },
        { relationshipCode: "peer", status: "pending" },
        { relationshipCode: "self", status: "submitted" }, // weight 0 -- never counted
        { relationshipCode: "supervisor", status: "submitted" }, // weight 0 -- never counted
        { relationshipCode: "subordinate", status: "submitted" },
      ],
      raterGroups,
      2
    );
    expect(gate.completedCount).toBe(2);
    expect(gate.ok).toBe(true);
  });

  it("fails when completed scoring raters are below the minimum", () => {
    const gate = meetsMinRatersGate(
      [{ relationshipCode: "peer", status: "submitted" }],
      raterGroups,
      3
    );
    expect(gate.ok).toBe(false);
    expect(gate.completedCount).toBe(1);
  });
});

describe("normalizeToPercent", () => {
  it("maps the scale minimum to 0 and the maximum to 100", () => {
    expect(normalizeToPercent(1, 1, 5)).toBe(0);
    expect(normalizeToPercent(5, 1, 5)).toBe(100);
  });

  it("maps the midpoint of a 1-5 scale to 50%", () => {
    expect(normalizeToPercent(3, 1, 5)).toBe(50);
  });

  it("returns null for a degenerate scale (max <= min)", () => {
    expect(normalizeToPercent(3, 5, 5)).toBeNull();
    expect(normalizeToPercent(3, 5, 1)).toBeNull();
  });
});

describe("combineWeighted", () => {
  it("computes the plain weighted average when every entry has data", () => {
    expect(combineWeighted([{ score: 4, weightPct: 50 }, { score: 2, weightPct: 50 }])).toBe(3);
  });

  it("excludes a null-score entry from both numerator and denominator instead of treating it as zero", () => {
    // If treated as zero: (4*50 + 0*50) / 100 = 2. Renormalized: 4.
    const result = combineWeighted([{ score: 4, weightPct: 50 }, { score: null, weightPct: 50 }]);
    expect(result).toBe(4);
  });

  it("returns null when no entry has any data", () => {
    expect(combineWeighted([{ score: null, weightPct: 50 }, { score: null, weightPct: 30 }])).toBeNull();
  });

  it("returns null on an empty entry list", () => {
    expect(combineWeighted([])).toBeNull();
  });
});

describe("computeItemGroupAverages", () => {
  it("averages adjusted values per (item, rater group) separately", () => {
    const responses: PreparedResponse[] = [
      { itemId: "i1", competencyId: "c1", relationshipCode: "peer", adjustedValue: 4 },
      { itemId: "i1", competencyId: "c1", relationshipCode: "peer", adjustedValue: 2 },
      { itemId: "i1", competencyId: "c1", relationshipCode: "subordinate", adjustedValue: 5 },
    ];
    const result = computeItemGroupAverages(responses);
    expect(result.get("i1")?.get("peer")).toBe(3);
    expect(result.get("i1")?.get("subordinate")).toBe(5);
  });

  it("excludes null (not-counted) responses from the average rather than treating them as zero", () => {
    const responses: PreparedResponse[] = [
      { itemId: "i1", competencyId: "c1", relationshipCode: "peer", adjustedValue: 4 },
      { itemId: "i1", competencyId: "c1", relationshipCode: "peer", adjustedValue: null },
    ];
    expect(computeItemGroupAverages(responses).get("i1")?.get("peer")).toBe(4);
  });

  it("produces no entry at all for an item/group with zero countable responses", () => {
    const responses: PreparedResponse[] = [
      { itemId: "i1", competencyId: "c1", relationshipCode: "peer", adjustedValue: null },
    ];
    expect(computeItemGroupAverages(responses).has("i1")).toBe(false);
  });
});

describe("computeCompetencyGroupScores", () => {
  it("averages a competency's own items' averages, per group", () => {
    const itemGroupAverages = new Map([
      ["i1", new Map([["peer", 4]])],
      ["i2", new Map([["peer", 2]])],
    ]);
    const result = computeCompetencyGroupScores(itemGroupAverages, [
      { id: "i1", competencyId: "c1" },
      { id: "i2", competencyId: "c1" },
    ]);
    expect(result.get("c1")?.get("peer")).toBe(3);
  });

  it("gives a competency no score in a group with zero answered items -- an entirely 'لم ألاحظ' competency for that group", () => {
    const itemGroupAverages = new Map<string, Map<string, number>>();
    const result = computeCompetencyGroupScores(itemGroupAverages, [{ id: "i1", competencyId: "c1" }]);
    expect(result.get("c1")).toBeUndefined();
  });
});

describe("computeCompetencyOfficialScores", () => {
  const raterGroups = [
    { relationshipCode: "peer", groupWeightPct: 60 },
    { relationshipCode: "subordinate", groupWeightPct: 40 },
  ];

  it("combines every group's competency score by group_weight_pct", () => {
    const scores = computeCompetencyOfficialScores(
      new Map([["c1", new Map([["peer", 4], ["subordinate", 2]])]]),
      raterGroups
    );
    // (4*60 + 2*40) / 100 = 3.2
    expect(scores.get("c1")).toBeCloseTo(3.2);
  });

  it("renormalizes when one scoring group has no data for the competency", () => {
    const scores = computeCompetencyOfficialScores(new Map([["c1", new Map([["peer", 4]])]]), raterGroups);
    expect(scores.get("c1")).toBe(4);
  });
});

describe("computeOverallScore", () => {
  it("combines competencies by weight_pct", () => {
    const competencies: Pick<ThreeSixtyCompetency, "id" | "weightPct">[] = [
      { id: "c1", weightPct: 70 },
      { id: "c2", weightPct: 30 },
    ];
    const overall = computeOverallScore(new Map([["c1", 4], ["c2", 2]]), competencies);
    expect(overall).toBeCloseTo(3.4);
  });

  it("returns null when no competency has a score", () => {
    const competencies: Pick<ThreeSixtyCompetency, "id" | "weightPct">[] = [{ id: "c1", weightPct: 100 }];
    expect(computeOverallScore(new Map([["c1", null]]), competencies)).toBeNull();
  });
});

describe("computeSelfGaps", () => {
  const competencies: ThreeSixtyCompetency[] = [
    { id: "c1", nameAr: "التواصل", weightPct: 40 },
    { id: "c2", nameAr: "القيادة", weightPct: 30 },
    { id: "c3", nameAr: "الجودة", weightPct: 30 },
  ];

  it("ranks by absolute gap descending and keeps only the top 3", () => {
    const competencyGroupScores = new Map([
      ["c1", new Map([["self", 5]])], // gap 5 - 3 = 2
      ["c2", new Map([["self", 4]])], // gap 4 - 3.9 = 0.1
      ["c3", new Map([["self", 1]])], // gap 1 - 4 = -3 (largest absolute)
    ]);
    const competencyOfficialScores = new Map([["c1", 3], ["c2", 3.9], ["c3", 4]]);
    const gaps = computeSelfGaps(competencyGroupScores, competencyOfficialScores, competencies);
    expect(gaps.map((g) => g.competencyId)).toEqual(["c3", "c1", "c2"]);
    expect(gaps[0].gap).toBe(-3);
  });

  it("skips a competency missing either the self score or the official score", () => {
    const competencyGroupScores = new Map([["c1", new Map([["self", 5]])]]);
    const competencyOfficialScores = new Map([["c1", null]]);
    expect(computeSelfGaps(competencyGroupScores, competencyOfficialScores, [competencies[0]])).toEqual([]);
  });
});

describe("rankItems", () => {
  const raterGroups = [{ relationshipCode: "peer", groupWeightPct: 100 }];

  it("returns top 3 and bottom 3, without padding when fewer than 6 items have data", () => {
    const itemGroupAverages = new Map([
      ["i1", new Map([["peer", 5]])],
      ["i2", new Map([["peer", 3]])],
      ["i3", new Map([["peer", 1]])],
    ]);
    const items = [
      { id: "i1", textAr: "أ", competencyId: "c1" },
      { id: "i2", textAr: "ب", competencyId: "c1" },
      { id: "i3", textAr: "ج", competencyId: "c1" },
    ];
    const { top, bottom } = rankItems(itemGroupAverages, items, raterGroups);
    expect(top.map((i) => i.itemId)).toEqual(["i1", "i2", "i3"]);
    expect(bottom.map((i) => i.itemId)).toEqual(["i3", "i2", "i1"]);
  });

  it("excludes an item with no countable data anywhere rather than padding with a fake zero", () => {
    const itemGroupAverages = new Map<string, Map<string, number>>();
    const items = [{ id: "i1", textAr: "أ", competencyId: "c1" }];
    const { top, bottom } = rankItems(itemGroupAverages, items, raterGroups);
    expect(top).toEqual([]);
    expect(bottom).toEqual([]);
  });
});

describe("shuffleOpenTextAnswers", () => {
  it("returns every input text, just reordered, without mutating the input array", () => {
    const input = ["a", "b", "c", "d"];
    const result = shuffleOpenTextAnswers(input, () => 0);
    expect(result.slice().sort()).toEqual(input.slice().sort());
    expect(input).toEqual(["a", "b", "c", "d"]);
  });

  it("is deterministic for an injected rng", () => {
    const rng = () => 0.999999; // pushes every swap to the last remaining index
    const first = shuffleOpenTextAnswers(["a", "b", "c"], rng);
    const second = shuffleOpenTextAnswers(["a", "b", "c"], rng);
    expect(first).toEqual(second);
  });
});

describe("groupCompletionStats", () => {
  it("counts total and submitted per relationship, excluding excluded assignments", () => {
    const stats = groupCompletionStats([
      { relationshipCode: "peer", status: "submitted" },
      { relationshipCode: "peer", status: "pending" },
      { relationshipCode: "peer", status: "excluded" },
      { relationshipCode: "supervisor", status: "submitted" },
    ]);
    const peer = stats.find((s) => s.relationshipCode === "peer")!;
    expect(peer.total).toBe(2);
    expect(peer.submitted).toBe(1);
    const supervisor = stats.find((s) => s.relationshipCode === "supervisor")!;
    expect(supervisor.total).toBe(1);
    expect(supervisor.submitted).toBe(1);
  });
});

describe("visibleGroupBreakdown", () => {
  const raterGroups = [
    raterGroup({ relationshipCode: "peer", shownSeparately: true, minRatersInGroup: 3 }),
    raterGroup({ relationshipCode: "supervisor", shownSeparately: true, minRatersInGroup: 1 }),
    raterGroup({ relationshipCode: "subordinate", shownSeparately: false, minRatersInGroup: 0 }),
  ];

  it("shows a group only when shown_separately AND the k-anonymity floor is met", () => {
    const { visible, folded } = visibleGroupBreakdown(raterGroups, [
      { relationshipCode: "peer", total: 4, submitted: 2 }, // below min_raters_in_group=3
      { relationshipCode: "supervisor", total: 1, submitted: 1 }, // meets min=1
      { relationshipCode: "subordinate", total: 2, submitted: 2 }, // not shown_separately at all
    ]);
    expect(visible.map((s) => s.relationshipCode)).toEqual(["supervisor"]);
    expect(folded.map((s) => s.relationshipCode).sort()).toEqual(["peer", "subordinate"]);
  });

  it("folds a stat for a relationship with no matching catalog row rather than crashing", () => {
    const { visible, folded } = visibleGroupBreakdown(raterGroups, [
      { relationshipCode: "unknown", total: 1, submitted: 1 },
    ]);
    expect(visible).toEqual([]);
    expect(folded).toHaveLength(1);
  });
});

describe("resolveThreeSixtyItemLevels", () => {
  it("uses the job title's own required_level for the competency's real counterpart", () => {
    const result = resolveThreeSixtyItemLevels(
      [{ id: "c1", sourceCompetencyId: "real-c1", appliesTo: "all" }],
      [{ competencyId: "real-c1", requiredLevel: "advanced" }]
    );
    expect(result.get("c1")).toBe("advanced");
  });

  it("falls back to practitioner for an 'all' competency when the job title has no required_level on record", () => {
    const result = resolveThreeSixtyItemLevels([{ id: "c1", sourceCompetencyId: "real-c1", appliesTo: "all" }], []);
    expect(result.get("c1")).toBe("practitioner");
  });

  it("honors a custom fallback", () => {
    const result = resolveThreeSixtyItemLevels([{ id: "c1", sourceCompetencyId: "real-c1", appliesTo: "all" }], [], "basic");
    expect(result.get("c1")).toBe("basic");
  });

  it("always falls back for an 'all' competency with no source (no per-job-title data could ever apply)", () => {
    const result = resolveThreeSixtyItemLevels(
      [{ id: "c1", sourceCompetencyId: null, appliesTo: "all" }],
      [{ competencyId: "real-c1", requiredLevel: "professional" }]
    );
    expect(result.get("c1")).toBe("practitioner");
  });

  it("includes a 'specialized' competency at its explicit required_level when the job title requires it", () => {
    const result = resolveThreeSixtyItemLevels(
      [{ id: "c1", sourceCompetencyId: "real-c1", appliesTo: "specialized" }],
      [{ competencyId: "real-c1", requiredLevel: "advanced" }]
    );
    expect(result.get("c1")).toBe("advanced");
  });

  it("excludes a 'specialized' competency entirely when the job title has no required_level on record (no fallback)", () => {
    const result = resolveThreeSixtyItemLevels([{ id: "c1", sourceCompetencyId: "real-c1", appliesTo: "specialized" }], []);
    expect(result.has("c1")).toBe(false);
  });

  it("excludes a 'specialized' competency with no source entirely (no per-job-title data could ever apply)", () => {
    const result = resolveThreeSixtyItemLevels([{ id: "c1", sourceCompetencyId: null, appliesTo: "specialized" }], []);
    expect(result.has("c1")).toBe(false);
  });
});

describe("itemsForSubjectLevel", () => {
  const resolvedLevels = new Map([
    ["c1", "advanced" as const],
    ["c2", "basic" as const],
  ]);

  it("keeps only items whose level matches the competency's resolved level", () => {
    const items = [
      item({ id: "a", competencyId: "c1", behavioralLevel: "advanced" }),
      item({ id: "b", competencyId: "c1", behavioralLevel: "basic" }),
      item({ id: "c", competencyId: "c2", behavioralLevel: "basic" }),
    ];
    expect(itemsForSubjectLevel(items, resolvedLevels).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("always keeps a level-agnostic item (behavioralLevel: null) regardless of resolved level", () => {
    const items = [item({ id: "open", competencyId: "c1", behavioralLevel: null })];
    expect(itemsForSubjectLevel(items, resolvedLevels).map((i) => i.id)).toEqual(["open"]);
  });

  it("excludes an item whose competency has no resolved level at all", () => {
    const items = [item({ id: "orphan", competencyId: "unknown-competency", behavioralLevel: "basic" })];
    expect(itemsForSubjectLevel(items, resolvedLevels)).toEqual([]);
  });
});

describe("nominationIdentityKey", () => {
  it("keys an internal rater by their profile id", () => {
    expect(nominationIdentityKey({ raterEmployeeId: "p1", externalRaterEmail: null })).toBe("p1");
  });

  it("keys an external rater by their lowercased, trimmed email", () => {
    expect(nominationIdentityKey({ raterEmployeeId: null, externalRaterEmail: "  Ext@Example.com  " })).toBe(
      "external:ext@example.com"
    );
  });

  it("gives two different external raters distinct keys, unlike a raw rater_employee_id template would", () => {
    const a = nominationIdentityKey({ raterEmployeeId: null, externalRaterEmail: "a@example.com" });
    const b = nominationIdentityKey({ raterEmployeeId: null, externalRaterEmail: "b@example.com" });
    expect(a).not.toBe(b);
  });
});

describe("canWriteThreeSixtyResponses", () => {
  it("allows saving answers while the assignment is still pending", () => {
    expect(canWriteThreeSixtyResponses("pending")).toBe(true);
  });

  it("locks answers once the assignment has been submitted", () => {
    expect(canWriteThreeSixtyResponses("submitted")).toBe(false);
  });

  it("locks answers for an excluded assignment", () => {
    expect(canWriteThreeSixtyResponses("excluded")).toBe(false);
  });
});
