-- ============================================================================
-- 20261018000003 — لا يُعتمد تقييم ناقص إلا بتجاوز مسبَّب
-- ============================================================================
-- القاعدة (قرار المالك 2026-10-18، تحليل الفجوات §2-أ): لا يُعتمد تقييم فيه
-- طريقة ذات وزن في توزيع الموظف بلا درجة واحدة، باستثناء 360 إن لم تكن للدورة
-- حلقة 360 مرتبطة. يجوز لحامل الاعتماد التجاوز بسبب يُسجَّل في اللقطة والتدقيق.
--
-- التطبيق يحسب الطرق الناقصة (src/lib/evaluationCompleteness.ts) بالأوزان
-- والمتوسطات نفسها التي يخزّنها في اللقطة ويمرّرها في `missing_required`؛
-- الدالة ترفض لقطة فيها نقص بلا `override_reason` (≥5 أحرف) وتخزّن السبب.
--
-- التراجع (Rollback): ALTER TABLE evaluation_results DROP COLUMN approval_override_reason,
--   DROP COLUMN missing_required; ثم إعادة تعريف الدالة من 20261018000002.
-- ============================================================================

BEGIN;

ALTER TABLE evaluation_results
  ADD COLUMN IF NOT EXISTS missing_required text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS approval_override_reason text;

COMMENT ON COLUMN evaluation_results.missing_required IS 'الطرق الموزونة التي كانت بلا درجة لحظة الاعتماد (فارغة = تقييم مكتمل).';
COMMENT ON COLUMN evaluation_results.approval_override_reason IS 'سبب تجاوز النقص الذي سجّله المعتمِد؛ NULL إذا كان التقييم مكتملًا.';

CREATE OR REPLACE FUNCTION approve_evaluation_with_result(p_evaluation_id uuid, p_result jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eval evaluations%ROWTYPE;
  v_unit uuid; v_supervisor uuid; v_title uuid;
  v_id uuid;
  v_missing_required text[];
  v_override text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'approve_evaluation_with_result: a signed-in approver is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_eval FROM evaluations WHERE id = p_evaluation_id AND deleted_at IS NULL FOR UPDATE;
  IF v_eval.id IS NULL THEN
    RAISE EXCEPTION 'approve_evaluation_with_result: evaluation % not found', p_evaluation_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT org_unit_id, supervisor_id, job_title_id INTO v_unit, v_supervisor, v_title FROM profiles WHERE id = v_eval.employee_id;
  IF NOT check_vpra('evaluation'::process_area, 'approve'::vpra_level, v_unit) THEN
    RAISE EXCEPTION 'approve_evaluation_with_result: the signed-in user may not approve %', p_evaluation_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_eval.state <> 'committee_reviewed' THEN
    RAISE EXCEPTION 'approve_evaluation_with_result: % is %, not committee_reviewed', p_evaluation_id, v_eval.state USING ERRCODE = 'check_violation';
  END IF;
  IF p_result IS NULL OR p_result->'weights' IS NULL OR p_result->'method_scores' IS NULL THEN
    RAISE EXCEPTION 'approve_evaluation_with_result: result snapshot is incomplete' USING ERRCODE = 'check_violation';
  END IF;

  v_missing_required := COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_result->'missing_required')), '{}');
  v_override := NULLIF(btrim(COALESCE(p_result->>'override_reason', '')), '');
  IF cardinality(v_missing_required) > 0 AND (v_override IS NULL OR length(v_override) < 5) THEN
    RAISE EXCEPTION 'approve_evaluation_with_result: % is incomplete (%), an override reason is required', p_evaluation_id, array_to_string(v_missing_required, ',')
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE evaluation_results SET superseded_at = now(), superseded_by = auth.uid(), reopen_reason = COALESCE(reopen_reason, 're-approved')
   WHERE evaluation_id = p_evaluation_id AND superseded_at IS NULL;

  INSERT INTO evaluation_results (
    evaluation_id, cycle_id, employee_id, org_unit_id, supervisor_id, job_title_id,
    weights, weights_source, method_scores, final_score, applied_weight, missing_methods,
    rating_band, feedback360_percent, scores_count, approved_by,
    missing_required, approval_override_reason
  ) VALUES (
    p_evaluation_id, v_eval.cycle_id, v_eval.employee_id, v_unit, v_supervisor, v_title,
    p_result->'weights',
    COALESCE(p_result->>'weights_source', 'cycle'),
    p_result->'method_scores',
    NULLIF(p_result->>'final_score', '')::numeric,
    COALESCE((p_result->>'applied_weight')::numeric, 0),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_result->'missing_methods')), '{}'),
    NULLIF(p_result->>'rating_band', ''),
    NULLIF(p_result->>'feedback360_percent', '')::numeric,
    COALESCE((p_result->>'scores_count')::integer, 0),
    auth.uid(),
    v_missing_required,
    CASE WHEN cardinality(v_missing_required) > 0 THEN v_override ELSE NULL END
  ) RETURNING id INTO v_id;

  UPDATE evaluations SET state = 'approved' WHERE id = p_evaluation_id AND state = 'committee_reviewed';
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION approve_evaluation_with_result IS 'اعتماد تقييم committee_reviewed مع تخزين لقطة نتيجته؛ يرفض لقطة فيها طرق ناقصة (missing_required) بلا سبب تجاوز ≥5 أحرف (20261018000003).';

SELECT column_name FROM information_schema.columns WHERE table_name = 'evaluation_results' AND column_name IN ('missing_required', 'approval_override_reason');

COMMIT;
