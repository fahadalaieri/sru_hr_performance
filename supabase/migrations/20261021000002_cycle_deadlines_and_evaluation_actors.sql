-- ============================================================================
-- 20261021000002 — مواعيد مراحل الدورة + من يجب أن يتصرّف في كل حالة
-- ============================================================================
-- المشكلة (تحليل الفجوات 2026-10-18 §2-ب): الدورة اسم وتاريخان وأربعة أوزان؛
-- لا آجال للمراحل ولا تذكير ولا إشعار لأي انتقال في مسار التقييم (الإشعارات
-- كلها للتوظيف). الإصلاح (قرار فهد 2026-10-21): أربعة مواعيد اختيارية لكل دورة،
-- ودالة تُجيب «من عليه الدور الآن» لتقييم بعينه، يستعملها التطبيق للإشعار عند
-- كل انتقال وللتذكير قبل الموعد بأسبوع ويوم وبعد فواته.
--
--   (1) evaluation_cycles: deadline_submit (آخر موعد لإرسال التقييم)،
--       deadline_supervisor (مراجعة الرئيس المباشر)، deadline_recommend
--       (توصية المدير ومراجعة اللجنة)، deadline_approve (الاعتماد النهائي).
--       كلها اختيارية ومرتّبة تصاعديًّا متى وُجدت.
--   (2) evaluation_actor_profile_ids(p_evaluation_id, p_state) → setof uuid:
--       معرّفات ملفات من عليهم التصرّف في الحالة المعطاة، بالعلاقة نفسها التي
--       يفرضها محفّز الحالة (20261018000001): الموظف عند draft، الرئيس المباشر
--       عند submitted، حاملو evaluation=recommend في النطاق عبر دور غير committee
--       عند supervisor_reviewed، دور committee في النطاق عند manager_recommended،
--       حاملو approve في النطاق عند committee_reviewed وapproved. SECURITY DEFINER
--       لأنها تقرأ user_roles/role_permissions التي لا يراها معظم المستدعين؛
--       تُنادى من الخادم بصلاحية الخدمة فقط (REVOKE من anon/authenticated).
--
-- التراجع (Rollback):
--   ALTER TABLE evaluation_cycles DROP COLUMN deadline_submit, DROP COLUMN deadline_supervisor,
--     DROP COLUMN deadline_recommend, DROP COLUMN deadline_approve;
--   DROP FUNCTION evaluation_actor_profile_ids(uuid, text);
-- ============================================================================

BEGIN;

ALTER TABLE evaluation_cycles
  ADD COLUMN IF NOT EXISTS deadline_submit date,
  ADD COLUMN IF NOT EXISTS deadline_supervisor date,
  ADD COLUMN IF NOT EXISTS deadline_recommend date,
  ADD COLUMN IF NOT EXISTS deadline_approve date;

ALTER TABLE evaluation_cycles DROP CONSTRAINT IF EXISTS evaluation_cycles_deadlines_ordered;
ALTER TABLE evaluation_cycles ADD CONSTRAINT evaluation_cycles_deadlines_ordered CHECK (
  (deadline_submit IS NULL OR deadline_supervisor IS NULL OR deadline_submit <= deadline_supervisor)
  AND (deadline_supervisor IS NULL OR deadline_recommend IS NULL OR deadline_supervisor <= deadline_recommend)
  AND (deadline_recommend IS NULL OR deadline_approve IS NULL OR deadline_recommend <= deadline_approve)
);

COMMENT ON COLUMN evaluation_cycles.deadline_submit IS 'آخر موعد لإرسال التقييم (draft → submitted). اختياري.';
COMMENT ON COLUMN evaluation_cycles.deadline_supervisor IS 'آخر موعد لمراجعة الرئيس المباشر (submitted → supervisor_reviewed). اختياري.';
COMMENT ON COLUMN evaluation_cycles.deadline_recommend IS 'آخر موعد لتوصية المدير ومراجعة اللجنة. اختياري.';
COMMENT ON COLUMN evaluation_cycles.deadline_approve IS 'آخر موعد للاعتماد النهائي والإقفال. اختياري.';

CREATE OR REPLACE FUNCTION evaluation_actor_profile_ids(p_evaluation_id uuid, p_state text)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ev AS (
    SELECT e.employee_id, p.supervisor_id, p.org_unit_id
      FROM evaluations e JOIN profiles p ON p.id = e.employee_id
     WHERE e.id = p_evaluation_id
  ),
  holders AS (
    -- Every signed-in profile holding an `evaluation` grant whose scope covers the employee's unit.
    SELECT DISTINCT pr.id AS profile_id, r.role_code, rp.vpra_level
      FROM ev
      JOIN user_roles ur ON (ur.scope_type = 'all' OR (ev.org_unit_id IS NOT NULL AND is_org_unit_in_scope(ev.org_unit_id, ur.org_unit_id)))
      JOIN roles r ON r.id = ur.role_id
      JOIN role_permissions rp ON rp.role_id = r.id AND rp.process_area = 'evaluation'::process_area
      JOIN profiles pr ON pr.auth_user_id = ur.user_id AND pr.deleted_at IS NULL
  )
  SELECT employee_id FROM ev WHERE p_state = 'draft'
  UNION
  SELECT supervisor_id FROM ev WHERE p_state = 'submitted' AND supervisor_id IS NOT NULL
  UNION
  SELECT profile_id FROM holders WHERE p_state = 'supervisor_reviewed' AND vpra_level = 'recommend' AND role_code <> 'committee'
  UNION
  SELECT profile_id FROM holders WHERE p_state = 'manager_recommended' AND role_code = 'committee'
  UNION
  SELECT profile_id FROM holders WHERE p_state IN ('committee_reviewed', 'approved') AND vpra_level = 'approve';
$$;

REVOKE ALL ON FUNCTION evaluation_actor_profile_ids(uuid, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION evaluation_actor_profile_ids IS 'ملفات من عليهم التصرّف في تقييم بحالة معيّنة، بالعلاقة نفسها التي يفرضها محفّز الحالة؛ للإشعارات والتذكيرات من الخادم فقط (20261021000002).';

SELECT column_name FROM information_schema.columns WHERE table_name = 'evaluation_cycles' AND column_name LIKE 'deadline_%' ORDER BY 1;

COMMIT;
