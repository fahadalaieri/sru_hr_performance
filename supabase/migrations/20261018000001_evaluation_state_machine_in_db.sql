-- ============================================================================
-- 20261018000001 — آلة حالة التقييم داخل قاعدة البيانات
-- ============================================================================
-- المشكلة (تحليل الفجوات 2026-10-18، docs/reviews/2026-10-18-platform-gap-analysis.md §2-أ):
--   (أ) سياسة evaluations_update (20260718000011) تسمح لصاحب الصف (الموظف نفسه)
--       ولكل حامل علاقة بتعديل أي عمود بلا قيد على الحالة؛ فيستطيع الموظف عبر
--       PostgREST نقل تقييمه من draft إلى approved مباشرة. آلة الحالة في
--       src/lib/vpra.ts تحمي الإجراء فقط لا الجدول.
--   (ب) إجراء الانتقال يختار أيّ دور يملكه المستخدم يصلح للحالة، لا علاقته
--       الفعلية بهذا التقييم: مشرف يحمل دور employee يُرسل مسودة مرؤوسه.
--   (ج) الدرجات تبقى قابلة للكتابة بعد الاعتماد: لا الإجراء ولا سياسات
--       evaluation_scores تقرأ حالة التقييم.
--   (د) تغيير أوزان الدورة أو الوحدة بعد بدء التسجيل يعيد كتابة كل نتيجة
--       محسوبة، لأن النتيجة تُحسب عند القراءة.
--
-- الإصلاح — القاعدة تعيش حيث تُكتب البيانات (النمط نفسه في 20261012000001):
--   (1) evaluations_state_transition: BEFORE UPDATE على evaluations.
--       - إلى الأمام خطوة واحدة فقط، وبالعلاقة لا بالدور:
--           draft → submitted              : الموظف نفسه أو رئيسه المباشر
--           submitted → supervisor_reviewed: الرئيس المباشر (is_my_direct_report)
--           supervisor_reviewed → manager_recommended: evaluation=recommend في النطاق عبر دور غير committee
--                                                        (البذرة تمنح manager وcommittee المستوى نفسه)
--           manager_recommended → committee_reviewed : دور committee في نطاق وحدة الموظف
--           committee_reviewed → approved  : check_vpra('evaluation','approve', وحدة الموظف)
--           approved → finalized           : check_vpra('evaluation','approve', وحدة الموظف)
--       - إلى الخلف (إعادة الفتح) : حامل approve فقط، وبخطوات غير مقيّدة.
--       - تخطّي حالة إلى الأمام   : مرفوض للجميع.
--       - أعمدة الهوية (employee_id, cycle_id, eval_type) لا تتغيّر؛ deleted_at
--         لحامل approve فقط.
--       - service_role / المالك (auth.uid() فارغ) غير مقيَّد: الهجرات والبذور
--         وإجراءات الخادم المصرّح بها.
--   (2) evaluation_scores_locked: BEFORE INSERT OR UPDATE OR DELETE على الدرجات.
--       - التقييم approved  : يكتب حامل approve فقط (تصحيح إداري، يُدقَّق في الإجراء).
--       - التقييم finalized : لا يكتب أحد سوى service_role.
--   (3) evaluation_weights_frozen: على evaluation_cycles (تغيير أعمدة الأوزان)
--       وعلى org_unit_evaluation_weights (كل كتابة): مرفوض متى كان في الدورة
--       تقييم واحد غادر draft. service_role غير مقيَّد.
--
-- لم يتغيّر: السياسات القائمة (تبقى طبقة أولى)، وجدول الحالات في vpra.ts
-- (يبقى فحصًا مسبقًا في التطبيق لإظهار الأزرار ورسائل أوضح).
--
-- التراجع (Rollback):
--   DROP TRIGGER evaluations_state_transition ON evaluations;
--   DROP TRIGGER evaluation_scores_locked ON evaluation_scores;
--   DROP TRIGGER evaluation_cycles_weights_frozen ON evaluation_cycles;
--   DROP TRIGGER org_unit_evaluation_weights_frozen ON org_unit_evaluation_weights;
--   DROP FUNCTION enforce_evaluation_state_transition();
--   DROP FUNCTION enforce_evaluation_scores_locked();
--   DROP FUNCTION enforce_evaluation_weights_frozen();
--   DROP FUNCTION evaluation_state_rank(text);
--   DROP FUNCTION has_role_code_in_scope(text, uuid);
--   DROP FUNCTION has_evaluation_level_in_scope(vpra_level, uuid, text);
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION evaluation_state_rank(p_state text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_state
    WHEN 'draft' THEN 0
    WHEN 'submitted' THEN 1
    WHEN 'supervisor_reviewed' THEN 2
    WHEN 'manager_recommended' THEN 3
    WHEN 'committee_reviewed' THEN 4
    WHEN 'approved' THEN 5
    WHEN 'finalized' THEN 6
  END;
$$;

-- Does the signed-in user hold `p_role_code` with a scope that covers `p_target_org_unit`?
-- (scope 'all', or an org_unit scope whose subtree contains the target.)
CREATE OR REPLACE FUNCTION has_role_code_in_scope(p_role_code text, p_target_org_unit uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND r.role_code = p_role_code
      AND (
        ur.scope_type = 'all'
        OR (p_target_org_unit IS NOT NULL AND is_org_unit_in_scope(p_target_org_unit, ur.org_unit_id))
      )
  );
$$;

REVOKE ALL ON FUNCTION has_role_code_in_scope(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION has_role_code_in_scope(text, uuid) TO authenticated;

-- Does the signed-in user hold, through a role OTHER than `p_exclude_code`, an
-- `evaluation` grant at exactly `p_level` whose scope covers the target unit?
-- Needed because the seeded matrix gives both `manager` and `committee`
-- evaluation=recommend: §4-A separates the manager step from the committee
-- step, so the manager step is "recommend through a non-committee role" and
-- the committee step is "the committee role" (has_role_code_in_scope).
CREATE OR REPLACE FUNCTION has_evaluation_level_in_scope(p_level vpra_level, p_target_org_unit uuid, p_exclude_code text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN role_permissions rp ON rp.role_id = r.id
    WHERE ur.user_id = auth.uid()
      AND rp.process_area = 'evaluation'::process_area
      AND rp.vpra_level = p_level
      AND (p_exclude_code IS NULL OR r.role_code <> p_exclude_code)
      AND (
        ur.scope_type = 'all'
        OR (p_target_org_unit IS NOT NULL AND is_org_unit_in_scope(p_target_org_unit, ur.org_unit_id))
      )
  );
$$;

REVOKE ALL ON FUNCTION has_evaluation_level_in_scope(vpra_level, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION has_evaluation_level_in_scope(vpra_level, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION enforce_evaluation_state_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit uuid;
  v_is_self boolean;
  v_is_supervisor boolean;
  v_approver boolean;
  v_from integer;
  v_to integer;
BEGIN
  -- Service role / owner (no JWT): migrations, seeds and server-side actions
  -- that deliberately use the admin client are not constrained here.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT org_unit_id, (auth_user_id = auth.uid())
    INTO v_unit, v_is_self
    FROM profiles WHERE id = NEW.employee_id;
  v_is_self := COALESCE(v_is_self, false);
  v_approver := check_vpra('evaluation'::process_area, 'approve'::vpra_level, v_unit);

  -- Identity columns never change through the API; soft-delete is for approvers.
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.cycle_id IS DISTINCT FROM OLD.cycle_id
     OR NEW.eval_type IS DISTINCT FROM OLD.eval_type THEN
    RAISE EXCEPTION 'evaluations: employee, cycle and type of % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NOT v_approver THEN
    RAISE EXCEPTION 'evaluations: only an evaluation approver may delete %', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  v_from := evaluation_state_rank(OLD.state);
  v_to := evaluation_state_rank(NEW.state);
  IF v_from IS NULL OR v_to IS NULL THEN
    RAISE EXCEPTION 'evaluations: unknown state % → %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;

  -- Backwards = reopen: approvers only (the application records the reason).
  IF v_to < v_from THEN
    IF v_approver THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'evaluations: only an evaluation approver may move % back from % to %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  -- Forwards: exactly one step, by the relationship that owns that step.
  IF v_to <> v_from + 1 THEN
    RAISE EXCEPTION 'evaluations: % may not skip from % to %', OLD.id, OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;

  v_is_supervisor := is_my_direct_report(NEW.employee_id);

  IF (OLD.state = 'draft' AND (v_is_self OR v_is_supervisor))
     OR (OLD.state = 'submitted' AND v_is_supervisor)
     OR (OLD.state = 'supervisor_reviewed' AND has_evaluation_level_in_scope('recommend'::vpra_level, v_unit, 'committee'))
     OR (OLD.state = 'manager_recommended' AND has_role_code_in_scope('committee', v_unit))
     OR (OLD.state = 'committee_reviewed' AND v_approver)
     OR (OLD.state = 'approved' AND v_approver) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'evaluations: the signed-in user may not move % from % to %', OLD.id, OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION enforce_evaluation_state_transition() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION enforce_evaluation_scores_locked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eval_id uuid;
  v_state text;
  v_unit uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_eval_id := COALESCE(NEW.evaluation_id, OLD.evaluation_id);
  SELECT e.state, p.org_unit_id INTO v_state, v_unit
    FROM evaluations e JOIN profiles p ON p.id = e.employee_id
   WHERE e.id = v_eval_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'evaluation_scores: unknown evaluation %', v_eval_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_state = 'finalized' THEN
    RAISE EXCEPTION 'evaluation_scores: evaluation % is finalized, scores are locked', v_eval_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_state = 'approved' AND NOT check_vpra('evaluation'::process_area, 'approve'::vpra_level, v_unit) THEN
    RAISE EXCEPTION 'evaluation_scores: evaluation % is approved, scores are locked', v_eval_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION enforce_evaluation_scores_locked() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION enforce_evaluation_weights_frozen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cycle uuid;
  v_changed boolean := true;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'evaluation_cycles' THEN
    v_cycle := OLD.id;
    v_changed := NEW.weight_activities IS DISTINCT FROM OLD.weight_activities
              OR NEW.weight_competencies IS DISTINCT FROM OLD.weight_competencies
              OR NEW.weight_bau IS DISTINCT FROM OLD.weight_bau
              OR NEW.weight_feedback_360 IS DISTINCT FROM OLD.weight_feedback_360;
  ELSE
    v_cycle := COALESCE(NEW.cycle_id, OLD.cycle_id);
  END IF;
  IF NOT v_changed THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF EXISTS (SELECT 1 FROM evaluations WHERE cycle_id = v_cycle AND deleted_at IS NULL AND state <> 'draft') THEN
    RAISE EXCEPTION 'evaluation weights of cycle % are frozen: an evaluation has already been submitted', v_cycle
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION enforce_evaluation_weights_frozen() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS evaluations_state_transition ON evaluations;
CREATE TRIGGER evaluations_state_transition
  BEFORE UPDATE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION enforce_evaluation_state_transition();

DROP TRIGGER IF EXISTS evaluation_scores_locked ON evaluation_scores;
CREATE TRIGGER evaluation_scores_locked
  BEFORE INSERT OR UPDATE OR DELETE ON evaluation_scores
  FOR EACH ROW EXECUTE FUNCTION enforce_evaluation_scores_locked();

DROP TRIGGER IF EXISTS evaluation_cycles_weights_frozen ON evaluation_cycles;
CREATE TRIGGER evaluation_cycles_weights_frozen
  BEFORE UPDATE ON evaluation_cycles
  FOR EACH ROW EXECUTE FUNCTION enforce_evaluation_weights_frozen();

DROP TRIGGER IF EXISTS org_unit_evaluation_weights_frozen ON org_unit_evaluation_weights;
CREATE TRIGGER org_unit_evaluation_weights_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON org_unit_evaluation_weights
  FOR EACH ROW EXECUTE FUNCTION enforce_evaluation_weights_frozen();

COMMENT ON FUNCTION enforce_evaluation_state_transition IS
  'انتقال حالة التقييم خطوة واحدة إلى الأمام بالعلاقة الفعلية (الموظف/رئيسه/recommend في النطاق/committee/approve)، وإلى الخلف لحامل approve فقط؛ أعمدة الهوية ثابتة (20261018000001).';
COMMENT ON FUNCTION enforce_evaluation_scores_locked IS
  'درجات التقييم تُقفل عند approved (يصحّحها حامل approve فقط) وعند finalized نهائيًّا (20261018000001).';
COMMENT ON FUNCTION enforce_evaluation_weights_frozen IS
  'أوزان الدورة والوحدة تتجمّد متى غادر تقييم واحد في الدورة حالة draft (20261018000001).';

-- تحقّق
SELECT tgname FROM pg_trigger
 WHERE tgrelid IN ('evaluations'::regclass, 'evaluation_scores'::regclass, 'evaluation_cycles'::regclass, 'org_unit_evaluation_weights'::regclass)
   AND NOT tgisinternal
 ORDER BY tgname;

COMMIT;
