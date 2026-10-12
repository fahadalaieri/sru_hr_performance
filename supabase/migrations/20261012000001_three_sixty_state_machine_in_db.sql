-- ============================================================================
-- 20261012000001 — آلة حالة تكليف 360 داخل قاعدة البيانات
-- ============================================================================
-- المشكلة (مراجعة Codex المستقلة 2026-10-12 للإصلاحات 1 و2):
--   (أ) قفل الإجابات بعد الإرسال (20261006000001) يعتمد على status التكليف،
--       لكن three_sixty_assignments_update (20260902000002) تسمح للمقيّم بتحديث
--       صفّه بلا أي قيد على الأعمدة أو الحالة. فيستطيع عبر PostgREST إرجاع
--       تكليفه من submitted إلى pending، وتعديل إجاباته، وإرساله ثانية.
--   (ب) إجراء الحفظ الخارجي يفحص الحالة ثم يكتب بصلاحية الخدمة دون شرط على
--       الحالة لحظة الكتابة؛ إرسال متزامن بين الفحص والكتابة يُدخل إجابة بعد
--       الإرسال. السياسات لا تحكم service_role، فلا تغلق هذه النافذة.
--
-- الإصلاح — القاعدة تعيش حيث تُكتب البيانات، وتسري على كل الأدوار بما فيها
-- service_role لأن المحفّزات لا تتجاوزها الصلاحيات:
--   (1) three_sixty_responses_assignment_pending: BEFORE INSERT OR UPDATE على
--       الإجابات يرفض الكتابة ما لم يكن التكليف pending لحظة الكتابة. الاستثناء
--       الوحيد: مستخدم مصادَق يحمل threeSixty >= approve (التصحيح الإداري الذي
--       تبقيه السياسات أصلًا). المسار الخارجي (service_role، auth.uid() فارغ)
--       لا استثناء له: بعد الإرسال لا يكتب شيئًا، وهذا يغلق سباق الحفظ/الإرسال.
--   (2) three_sixty_assignments_rater_transition: BEFORE UPDATE على التكليفات؛
--       من لا يحمل threeSixty >= prepare (أي المقيّم العادي) يُسمح له بتغيير
--       واحد فقط: status من pending إلى submitted، وكل الأعمدة الأخرى يجب أن
--       تبقى كما هي. حاملو prepare/approve (المشرفون والإداريون) وصلاحية
--       الخدمة (الإرسال الخارجي، الهجرات) غير مقيَّدين بهذا المحفّز.
--
-- لم يتغيّر: السياسات القائمة (تبقى طبقة أولى)، والتحقق من انطباق السؤال على
-- التكليف يبقى في طبقة التطبيق كما وُثّق في 20261006000002.
--
-- التراجع (Rollback):
--   DROP TRIGGER three_sixty_responses_assignment_pending ON three_sixty_responses;
--   DROP TRIGGER three_sixty_assignments_rater_transition ON three_sixty_assignments;
--   DROP FUNCTION enforce_three_sixty_response_assignment_pending();
--   DROP FUNCTION enforce_three_sixty_assignment_rater_transition();
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION enforce_three_sixty_response_assignment_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status three_sixty_assignment_status;
BEGIN
  -- SECURITY DEFINER: the status must be read regardless of the caller's own
  -- RLS view of the assignment; the function reads one column and decides.
  SELECT status INTO v_status FROM three_sixty_assignments WHERE id = NEW.assignment_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'three_sixty_responses: unknown assignment %', NEW.assignment_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_status = 'pending' THEN
    RETURN NEW;
  END IF;
  -- Administrative correction only: a real signed-in user holding approve.
  IF auth.uid() IS NOT NULL AND check_vpra_global('threeSixty'::process_area, 'approve'::vpra_level) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'three_sixty_responses: assignment % is %, answers are locked', NEW.assignment_id, v_status
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION enforce_three_sixty_response_assignment_pending() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION enforce_three_sixty_assignment_rater_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Service role / owner (no JWT) and privileged users are not constrained here.
  IF auth.uid() IS NULL OR check_vpra_global('threeSixty'::process_area, 'prepare'::vpra_level) THEN
    RETURN NEW;
  END IF;
  -- A plain rater may do exactly one thing to their assignment: submit it.
  IF OLD.status <> 'pending' OR NEW.status <> 'submitted' THEN
    RAISE EXCEPTION 'three_sixty_assignments: a rater may only move % from pending to submitted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'three_sixty_assignments: a rater may not change anything but status on %', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_three_sixty_assignment_rater_transition() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS three_sixty_responses_assignment_pending ON three_sixty_responses;
CREATE TRIGGER three_sixty_responses_assignment_pending
  BEFORE INSERT OR UPDATE ON three_sixty_responses
  FOR EACH ROW EXECUTE FUNCTION enforce_three_sixty_response_assignment_pending();

DROP TRIGGER IF EXISTS three_sixty_assignments_rater_transition ON three_sixty_assignments;
CREATE TRIGGER three_sixty_assignments_rater_transition
  BEFORE UPDATE ON three_sixty_assignments
  FOR EACH ROW EXECUTE FUNCTION enforce_three_sixty_assignment_rater_transition();

COMMENT ON FUNCTION enforce_three_sixty_response_assignment_pending IS
  'إجابات 360 تُكتب فقط لتكليف pending لحظة الكتابة، لكل الأدوار بما فيها service_role؛ استثناء وحيد لمستخدم مصادَق يحمل threeSixty>=approve (20261012000001).';
COMMENT ON FUNCTION enforce_three_sixty_assignment_rater_transition IS
  'المقيّم العادي (بلا threeSixty>=prepare) يغيّر تكليفه في اتجاه واحد فقط: pending→submitted ولا شيء غيره (20261012000001).';

COMMIT;

-- تحقّق — يُشغَّل بعد التطبيق:
-- SELECT tgname FROM pg_trigger WHERE tgrelid IN ('three_sixty_responses'::regclass,'three_sixty_assignments'::regclass) AND NOT tgisinternal;
-- المتوقع: three_sixty_responses_validate، three_sixty_responses_assignment_pending، three_sixty_assignments_rater_transition.
