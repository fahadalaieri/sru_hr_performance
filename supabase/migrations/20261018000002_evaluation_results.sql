-- ============================================================================
-- 20261018000002 — النتيجة الرسمية المخزّنة للتقييم + الاعتماد/الإقفال/إعادة الفتح ذريًّا
-- ============================================================================
-- المشكلة (تحليل الفجوات 2026-10-18 §1 و§2-أ): لا نتيجة رسمية مخزّنة؛ الدرجة
-- الموزونة تُحسب عند كل قراءة تحت صلاحيات القارئ، من كل الحالات، وتتغيّر إذا
-- تغيّرت وحدة الموظف أو رئيسه أو الأوزان. ولا شيء ينفّذ approved → finalized،
-- ولا مسار لإعادة الفتح بسبب مسجَّل. (CLAUDE.md §5: «لا تقديرات مشتقة تُخزَّن
-- بلا بياناتها المصدرية» — لذلك تُحفظ مع الدرجة مكوّناتها وأوزانها وعدّاد
-- الدرجات المصدرية، وتبقى الدرجات نفسها مقفلة بمحفّز 20261018000001.)
--
-- الإصلاح:
--   (1) جدول evaluation_results: لقطة لحظة الاعتماد — الدرجة النهائية والنطاق
--       ومتوسط كل طريقة والأوزان المطبَّقة ومصدرها والطرق الغائبة ووزنها المطبَّق
--       ونتيجة 360 وعدد الدرجات المصدرية، مع وحدة الموظف ورئيسه ومسمّاه لحظتها.
--       صف واحد «جارٍ» لكل تقييم (فهرس فريد جزئي)؛ إعادة الفتح تُلغي الصف
--       (superseded_at + السبب) ويبقى تاريخًا، والاعتماد التالي يُنشئ صفًّا جديدًا.
--   (2) ثلاث دوال SECURITY DEFINER تجعل كل خطوة ذرية (لقطة + حالة في معاملة
--       واحدة) وتفحص صلاحية الاعتماد بنفسها، ثم تمرّ بمحفّز الحالة كأي تحديث:
--         approve_evaluation_with_result(p_evaluation_id, p_result jsonb) → uuid
--         finalize_evaluation(p_evaluation_id)
--         reopen_evaluation(p_evaluation_id, p_to_state, p_reason)
--       الحساب نفسه يبقى في التطبيق (src/lib/evaluationResult.ts) الذي يحسب
--       النتائج الحية؛ فالرقم المخزّن هو الرقم الذي رآه المعتمِد.
--   (3) RLS على evaluation_results للقراءة فقط (الموظف نفسه، رئيسه المباشر،
--       recommend في النطاق، وevaluationResultsReports=view في النطاق — وهو
--       الفرع الذي كان مجال التقارير يفتقر إليه). لا كتابة إلا عبر الدوال.
--
-- التراجع (Rollback):
--   DROP FUNCTION approve_evaluation_with_result(uuid, jsonb);
--   DROP FUNCTION finalize_evaluation(uuid);
--   DROP FUNCTION reopen_evaluation(uuid, text, text);
--   DROP TABLE evaluation_results;
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS evaluation_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id       uuid NOT NULL REFERENCES evaluations(id) ON DELETE RESTRICT,
  cycle_id            uuid NOT NULL REFERENCES evaluation_cycles(id) ON DELETE RESTRICT,
  employee_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  org_unit_id         uuid REFERENCES org_units(id) ON DELETE SET NULL,
  supervisor_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  job_title_id        uuid REFERENCES job_titles(id) ON DELETE SET NULL,
  weights             jsonb NOT NULL,
  weights_source      text NOT NULL CHECK (weights_source IN ('cycle', 'orgUnit')),
  method_scores       jsonb NOT NULL,
  final_score         numeric(5,2) CHECK (final_score IS NULL OR (final_score >= 0 AND final_score <= 100)),
  applied_weight      numeric(5,2) NOT NULL,
  missing_methods     text[] NOT NULL DEFAULT '{}',
  rating_band         text,
  feedback360_percent numeric(5,2),
  scores_count        integer NOT NULL DEFAULT 0,
  approved_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at         timestamptz NOT NULL DEFAULT now(),
  superseded_at       timestamptz,
  superseded_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reopen_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS evaluation_results_current_unique
  ON evaluation_results (evaluation_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS evaluation_results_cycle_employee_idx ON evaluation_results (cycle_id, employee_id);

COMMENT ON TABLE evaluation_results IS 'لقطة النتيجة الرسمية لحظة اعتماد التقييم (20261018000002): الدرجة ومكوّناتها وأوزانها وسياق الموظف. صف جارٍ واحد لكل تقييم؛ إعادة الفتح تُلغيه بسبب ويبقى تاريخًا.';

ALTER TABLE evaluation_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON evaluation_results FROM anon;
GRANT SELECT ON evaluation_results TO authenticated;

DROP POLICY IF EXISTS evaluation_results_select ON evaluation_results;
CREATE POLICY evaluation_results_select ON evaluation_results FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = evaluation_results.employee_id AND p.auth_user_id = auth.uid())
    OR is_my_direct_report(evaluation_results.employee_id)
    OR check_vpra('evaluation'::process_area, 'recommend'::vpra_level, evaluation_results.org_unit_id)
    OR check_vpra('evaluationResultsReports'::process_area, 'view'::vpra_level, evaluation_results.org_unit_id)
  );
-- No INSERT/UPDATE/DELETE policies: writes happen only inside the three functions below.

-- ---------------------------------------------------------------------------
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

  -- A stale current row (should not exist after a proper reopen) is superseded, never duplicated.
  UPDATE evaluation_results SET superseded_at = now(), superseded_by = auth.uid(), reopen_reason = COALESCE(reopen_reason, 're-approved')
   WHERE evaluation_id = p_evaluation_id AND superseded_at IS NULL;

  INSERT INTO evaluation_results (
    evaluation_id, cycle_id, employee_id, org_unit_id, supervisor_id, job_title_id,
    weights, weights_source, method_scores, final_score, applied_weight, missing_methods,
    rating_band, feedback360_percent, scores_count, approved_by
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
    auth.uid()
  ) RETURNING id INTO v_id;

  -- The state trigger (20261018000001) re-validates this as an approver's forward step.
  UPDATE evaluations SET state = 'approved' WHERE id = p_evaluation_id AND state = 'committee_reviewed';
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION finalize_evaluation(p_evaluation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eval evaluations%ROWTYPE;
  v_unit uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'finalize_evaluation: a signed-in approver is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_eval FROM evaluations WHERE id = p_evaluation_id AND deleted_at IS NULL FOR UPDATE;
  IF v_eval.id IS NULL THEN
    RAISE EXCEPTION 'finalize_evaluation: evaluation % not found', p_evaluation_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT org_unit_id INTO v_unit FROM profiles WHERE id = v_eval.employee_id;
  IF NOT check_vpra('evaluation'::process_area, 'approve'::vpra_level, v_unit) THEN
    RAISE EXCEPTION 'finalize_evaluation: the signed-in user may not finalize %', p_evaluation_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_eval.state <> 'approved' THEN
    RAISE EXCEPTION 'finalize_evaluation: % is %, not approved', p_evaluation_id, v_eval.state USING ERRCODE = 'check_violation';
  END IF;
  -- The official (supervisor) evaluation is never finalized without its stored result.
  IF v_eval.eval_type = 'supervisor'
     AND NOT EXISTS (SELECT 1 FROM evaluation_results WHERE evaluation_id = p_evaluation_id AND superseded_at IS NULL) THEN
    RAISE EXCEPTION 'finalize_evaluation: % has no stored result', p_evaluation_id USING ERRCODE = 'check_violation';
  END IF;
  UPDATE evaluations SET state = 'finalized' WHERE id = p_evaluation_id AND state = 'approved';
END;
$$;

CREATE OR REPLACE FUNCTION reopen_evaluation(p_evaluation_id uuid, p_to_state text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eval evaluations%ROWTYPE;
  v_unit uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'reopen_evaluation: a signed-in approver is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'reopen_evaluation: a reason of at least 5 characters is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_eval FROM evaluations WHERE id = p_evaluation_id AND deleted_at IS NULL FOR UPDATE;
  IF v_eval.id IS NULL THEN
    RAISE EXCEPTION 'reopen_evaluation: evaluation % not found', p_evaluation_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT org_unit_id INTO v_unit FROM profiles WHERE id = v_eval.employee_id;
  IF NOT check_vpra('evaluation'::process_area, 'approve'::vpra_level, v_unit) THEN
    RAISE EXCEPTION 'reopen_evaluation: the signed-in user may not reopen %', p_evaluation_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF evaluation_state_rank(p_to_state) IS NULL OR evaluation_state_rank(p_to_state) >= evaluation_state_rank(v_eval.state) THEN
    RAISE EXCEPTION 'reopen_evaluation: % cannot be reopened from % to %', p_evaluation_id, v_eval.state, p_to_state USING ERRCODE = 'check_violation';
  END IF;
  -- The stored result no longer describes an approved evaluation: retire it, keep it as history.
  UPDATE evaluation_results SET superseded_at = now(), superseded_by = auth.uid(), reopen_reason = btrim(p_reason)
   WHERE evaluation_id = p_evaluation_id AND superseded_at IS NULL;
  UPDATE evaluations SET state = p_to_state WHERE id = p_evaluation_id;
END;
$$;

REVOKE ALL ON FUNCTION approve_evaluation_with_result(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION finalize_evaluation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION reopen_evaluation(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_evaluation_with_result(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION finalize_evaluation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION reopen_evaluation(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION approve_evaluation_with_result IS 'اعتماد تقييم committee_reviewed مع تخزين لقطة نتيجته الرسمية في معاملة واحدة؛ حامل evaluation=approve في نطاق الموظف فقط (20261018000002).';
COMMENT ON FUNCTION finalize_evaluation IS 'إقفال تقييم approved نهائيًّا؛ تقييم الرئيس المباشر لا يُقفل بلا نتيجة مخزّنة (20261018000002).';
COMMENT ON FUNCTION reopen_evaluation IS 'إعادة فتح تقييم إلى حالة سابقة بسبب (≥5 أحرف) لحامل approve؛ تُلغي النتيجة المخزّنة وتُبقيها تاريخًا (20261018000002).';

-- تحقّق
SELECT count(*) AS results_rows FROM evaluation_results;
SELECT proname FROM pg_proc WHERE proname IN ('approve_evaluation_with_result', 'finalize_evaluation', 'reopen_evaluation') ORDER BY 1;

COMMIT;
