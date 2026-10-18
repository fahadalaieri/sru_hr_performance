import { describe, expect, it } from "vitest";
import { computeEmployeeCycleResult } from "./evaluationResult";
import { toResultSnapshot } from "./evaluationResultSnapshot";

const weights = { activities: 25, competencies: 25, bau: 25, feedback360: 25 };

describe("toResultSnapshot", () => {
  it("keeps the live computation's number, band, weights and the missing methods", () => {
    const result = computeEmployeeCycleResult({
      employeeId: "e", evaluationId: "v", orgUnitId: "u",
      cycleWeights: weights, orgUnitWeights: null,
      inputs: { activityScores: [], competencyScores: [80, 90], bauTaskScores: [70], feedback360Percent: null },
    });
    const snap = toResultSnapshot(result, 3);
    expect(snap.weights_source).toBe("cycle");
    expect(snap.method_scores).toEqual({ activities: null, competencies: 85, bau: 70, feedback360: null });
    expect(snap.final_score).toBe(result.score == null ? null : Math.round(result.score * 100) / 100);
    expect(snap.final_score).toBe(77.5); // (85+70)/2 after renormalising the two available methods
    expect(snap.applied_weight).toBe(50);
    expect(snap.missing_methods.sort()).toEqual(["activities", "feedback360"]);
    expect(snap.rating_band).toBe("good");
    expect(snap.scores_count).toBe(3);
  });

  it("an evaluation without any score snapshots as null, never 0", () => {
    const result = computeEmployeeCycleResult({
      employeeId: "e", evaluationId: "v", orgUnitId: null,
      cycleWeights: weights, orgUnitWeights: null,
      inputs: { activityScores: [], competencyScores: [], bauTaskScores: [], feedback360Percent: null },
    });
    const snap = toResultSnapshot(result, 0);
    expect(snap.final_score).toBeNull();
    expect(snap.rating_band).toBeNull();
    expect(snap.applied_weight).toBe(0);
  });

  it("records the org-unit distribution when one applies", () => {
    const result = computeEmployeeCycleResult({
      employeeId: "e", evaluationId: "v", orgUnitId: "u",
      cycleWeights: weights, orgUnitWeights: { activities: 10, competencies: 60, bau: 10, feedback360: 20 },
      inputs: { activityScores: [50], competencyScores: [100], bauTaskScores: [50], feedback360Percent: 80 },
    });
    const snap = toResultSnapshot(result, 3);
    expect(snap.weights_source).toBe("orgUnit");
    expect(snap.weights).toEqual({ activities: 10, competencies: 60, bau: 10, feedback360: 20 });
    expect(snap.final_score).toBe(86); // 5 + 60 + 5 + 16
    expect(snap.feedback360_percent).toBe(80);
  });
});
