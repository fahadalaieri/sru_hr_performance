import { describe, expect, it } from "vitest";
import { assessCompleteness } from "./evaluationCompleteness";

const w = (activities: number, competencies: number, bau: number, feedback360: number) => ({ activities, competencies, bau, feedback360 });

describe("assessCompleteness", () => {
  it("every weighted method scored → complete", () => {
    const v = assessCompleteness({ weights: w(25, 25, 25, 25), methodScores: { activities: 70, competencies: 80, bau: 90, feedback360: 60 }, hasThreeSixtyCycle: true });
    expect(v).toEqual({ complete: true, missingRequired: [] });
  });

  it("a weighted method with no score blocks approval", () => {
    const v = assessCompleteness({ weights: w(25, 25, 25, 25), methodScores: { competencies: 80 }, hasThreeSixtyCycle: true });
    expect(v.complete).toBe(false);
    expect(v.missingRequired).toEqual(["activities", "bau", "feedback360"]);
  });

  it("360 is not required when the cycle has no linked 360 cycle", () => {
    const v = assessCompleteness({ weights: w(25, 25, 25, 25), methodScores: { activities: 70, competencies: 80, bau: 90, feedback360: null }, hasThreeSixtyCycle: false });
    expect(v).toEqual({ complete: true, missingRequired: [] });
  });

  it("a method with zero weight is never required", () => {
    const v = assessCompleteness({ weights: w(0, 100, 0, 0), methodScores: { competencies: 80 }, hasThreeSixtyCycle: true });
    expect(v).toEqual({ complete: true, missingRequired: [] });
  });

  it("a scored method with value 0 counts as scored", () => {
    const v = assessCompleteness({ weights: w(50, 50, 0, 0), methodScores: { activities: 0, competencies: 55 }, hasThreeSixtyCycle: false });
    expect(v.complete).toBe(true);
  });
});
