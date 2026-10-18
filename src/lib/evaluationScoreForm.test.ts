import { describe, expect, it } from "vitest";
import { collectScoreRows, type ScoreSubjects } from "./evaluationScoreForm";

const subjects: ScoreSubjects = {
  competencies: ["c1", "c2"],
  activities: ["a1"],
  bauTasks: ["b1"],
};
const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
};

describe("collectScoreRows", () => {
  it("writes only the subjects whose fields the form actually posted", () => {
    // The scores page shows ONE method at a time (?method=bau): the other
    // methods' fields are absent and must be left untouched, not nulled.
    const r = collectScoreRows(form({ score_bau_b1: "80", comment_bau_b1: "جيد" }), subjects);
    expect(r).toEqual({ ok: true, rows: [{ subjectColumn: "bau_task_id", subjectId: "b1", score: 80, comment: "جيد" }] });
  });

  it("a posted but empty field clears that subject (score and comment null)", () => {
    const r = collectScoreRows(form({ score_competency_c1: "", comment_competency_c1: "" }), subjects);
    expect(r).toEqual({ ok: true, rows: [{ subjectColumn: "competency_id", subjectId: "c1", score: null, comment: null }] });
  });

  it("a comment alone counts as posted", () => {
    const r = collectScoreRows(form({ comment_activity_a1: "ملاحظة" }), subjects);
    expect(r).toEqual({ ok: true, rows: [{ subjectColumn: "activity_id", subjectId: "a1", score: null, comment: "ملاحظة" }] });
  });

  it("ignores fields for subjects that do not belong to this evaluation", () => {
    const r = collectScoreRows(form({ score_competency_zzz: "50", score_competency_c2: "70" }), subjects);
    expect(r).toEqual({ ok: true, rows: [{ subjectColumn: "competency_id", subjectId: "c2", score: 70, comment: null }] });
  });

  it("rejects an out-of-range or non-numeric score", () => {
    expect(collectScoreRows(form({ score_competency_c1: "101" }), subjects)).toEqual({ ok: false });
    expect(collectScoreRows(form({ score_competency_c1: "abc" }), subjects)).toEqual({ ok: false });
    expect(collectScoreRows(form({ score_competency_c1: "-1" }), subjects)).toEqual({ ok: false });
  });

  it("accepts boundaries and trims", () => {
    const r = collectScoreRows(form({ score_competency_c1: " 0 ", score_competency_c2: "100" }), subjects);
    expect(r.ok && r.rows.map((x) => x.score)).toEqual([0, 100]);
  });

  it("an empty form writes nothing", () => {
    expect(collectScoreRows(form({}), subjects)).toEqual({ ok: true, rows: [] });
  });
});
