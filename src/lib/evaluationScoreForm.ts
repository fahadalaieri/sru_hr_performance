/**
 * Turns the scores form into rows to write — and nothing more than the form
 * actually posted.
 *
 * Found in the 2026-10-18 gap review (docs/reviews/2026-10-18-platform-gap-analysis.md
 * §2-أ): the scores page shows ONE method at a time (`?method=bau`), but the
 * action rebuilt a row for EVERY subject of the evaluation, read the absent
 * fields as empty, and wrote `null` over the other methods' saved scores and
 * comments. Saving the BAU tab erased the competency scores.
 *
 * Rule here: a subject is written only when the form carries at least one of
 * its two fields (`score_<prefix>_<id>` / `comment_<prefix>_<id>`). A field
 * that is present but empty still clears that subject — that is the user
 * deliberately blanking a value they could see. A subject whose fields were
 * never rendered is untouched.
 *
 * The subject lists are the server's (re-derived from the evaluation), never
 * the client's: a posted field for a subject outside them is ignored.
 */
export interface ScoreSubjects {
  competencies: string[];
  activities: string[];
  bauTasks: string[];
}

export type ScoreSubjectColumn = "competency_id" | "activity_id" | "bau_task_id";

export interface ScoreRow {
  subjectColumn: ScoreSubjectColumn;
  subjectId: string;
  score: number | null;
  comment: string | null;
}

export type CollectScoreRowsResult = { ok: true; rows: ScoreRow[] } | { ok: false };

const PREFIXES: Array<[keyof ScoreSubjects, string, ScoreSubjectColumn]> = [
  ["competencies", "competency", "competency_id"],
  ["activities", "activity", "activity_id"],
  ["bauTasks", "bau", "bau_task_id"],
];

/** Minimal read surface of FormData, so tests and the action share one shape. */
export interface FormValues {
  has(name: string): boolean;
  get(name: string): FormDataEntryValue | null;
}

export function collectScoreRows(form: FormValues, subjects: ScoreSubjects): CollectScoreRowsResult {
  const rows: ScoreRow[] = [];
  for (const [key, prefix, subjectColumn] of PREFIXES) {
    for (const subjectId of subjects[key]) {
      const scoreName = `score_${prefix}_${subjectId}`;
      const commentName = `comment_${prefix}_${subjectId}`;
      if (!form.has(scoreName) && !form.has(commentName)) continue;

      const rawScore = form.has(scoreName) ? String(form.get(scoreName) ?? "").trim() : "";
      let score: number | null = null;
      if (rawScore !== "") {
        const n = Number(rawScore);
        if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false };
        score = n;
      }
      const rawComment = form.has(commentName) ? String(form.get(commentName) ?? "").trim() : "";
      rows.push({ subjectColumn, subjectId, score, comment: rawComment === "" ? null : rawComment });
    }
  }
  return { ok: true, rows };
}
