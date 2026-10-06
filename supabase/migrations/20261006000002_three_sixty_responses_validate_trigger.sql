-- ============================================================================
-- 20261006000002 — تحقّق قاعدة البيانات من اتساق إجابة تقييم 360 مع سؤالها
-- ============================================================================
-- المشكلة (مراجعة 2026-10-05، الأولوية الثانية):
--   three_sixty_responses يقبل أي option_id موجود وأي numeric_value يرسله
--   العميل. قيود FK تتحقق من "الوجود" لا "التوافق": يمكن إرسال خيار من مقياس
--   آخر غير مقياس السؤال، أو قيمة رقمية لا تطابق الخيار، أو خيار على سؤال نصي.
--   إجراءا الحفظ يتحققان الآن في طبقة التطبيق، لكن قاعدة البيانات هي الحد
--   الأخير (PROJECT_STRICT قاعدة 16)، خاصةً أن المسار الخارجي يكتب بصلاحية
--   service_role متجاوزًا RLS.
--
-- الإصلاح:
--   محفّز BEFORE INSERT OR UPDATE يفرض:
--     - سؤال open_text: لا option_id ولا numeric_value.
--     - سؤال rating مع option_id: scale_code الخيار = scale_code السؤال،
--       و numeric_value تُشتق من الخيار دائمًا (يُستبدل ما أرسله العميل).
--     - سؤال rating بلا option_id (إجابة مُفرَّغة): لا numeric_value ولا text_value.
--   المحفّز ليس SECURITY DEFINER؛ يقرأ الأسئلة والخيارات تحت RLS المستدعي،
--   وكلاهما مقروء لكل مستخدم مصادَق أصلًا (شاشة الاستبيان تقرؤهما).
--
-- ما لا يغطيه عمدًا:
--   انطباق السؤال على التكليف (العلاقة + مستوى الجدارة) يبقى في طبقة
--   التطبيق (resolveApplicableThreeSixtyItems)، لأن منطقه TypeScript مركّب
--   ولا يُعاد كتابته في SQL داخل إصلاح ضيق.
--
-- بيانات البذر متّسقة قبل التطبيق (تحقّق 2026-10-06 على قاعدة التطوير):
--   216 سؤال rating كلها على behavior_freq_5 الذي له 6 خيارات، وسؤال open_text
--   واحد بلا مقياس، وجدول الإجابات فارغ.
--
-- التراجع (Rollback):
--   DROP TRIGGER three_sixty_responses_validate ON three_sixty_responses;
--   DROP FUNCTION validate_three_sixty_response();
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION validate_three_sixty_response()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item_type  three_sixty_item_type;
  v_item_scale TEXT;
  v_opt_scale  TEXT;
  v_opt_value  NUMERIC(6, 2);
BEGIN
  SELECT item_type, scale_code INTO v_item_type, v_item_scale
  FROM three_sixty_items WHERE id = NEW.item_id;

  IF v_item_type IS NULL THEN
    RAISE EXCEPTION 'three_sixty_responses: unknown or unreadable item %', NEW.item_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_item_type = 'open_text' THEN
    IF NEW.option_id IS NOT NULL OR NEW.numeric_value IS NOT NULL THEN
      RAISE EXCEPTION 'three_sixty_responses: open_text item % cannot carry an option or a numeric value', NEW.item_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- rating
  IF NEW.option_id IS NULL THEN
    IF NEW.numeric_value IS NOT NULL OR NEW.text_value IS NOT NULL THEN
      RAISE EXCEPTION 'three_sixty_responses: rating item % without an option cannot carry a value', NEW.item_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT scale_code, numeric_value INTO v_opt_scale, v_opt_value
  FROM three_sixty_rating_scale_options WHERE id = NEW.option_id AND deleted_at IS NULL;

  IF v_opt_scale IS NULL OR v_opt_scale IS DISTINCT FROM v_item_scale THEN
    RAISE EXCEPTION 'three_sixty_responses: option % does not belong to scale % of item %', NEW.option_id, v_item_scale, NEW.item_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.text_value IS NOT NULL THEN
    RAISE EXCEPTION 'three_sixty_responses: rating item % cannot carry free text', NEW.item_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The score is a property of the chosen option, never of the request.
  NEW.numeric_value := v_opt_value;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION validate_three_sixty_response IS
  'يفرض اتساق إجابة 360 مع سؤالها: خيار من مقياس السؤال نفسه، والقيمة الرقمية مشتقة من الخيار لا من العميل، ولا خيار على سؤال نصي (20261006000002).';

DROP TRIGGER IF EXISTS three_sixty_responses_validate ON three_sixty_responses;
CREATE TRIGGER three_sixty_responses_validate
  BEFORE INSERT OR UPDATE ON three_sixty_responses
  FOR EACH ROW EXECUTE FUNCTION validate_three_sixty_response();

COMMIT;

-- ============================================================================
-- تحقّق — يُشغَّل بعد التطبيق (PROJECT_STRICT قاعدة 10).
-- ============================================================================
-- المتوقع: صف واحد باسم المحفّز على three_sixty_responses.
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'three_sixty_responses'::regclass AND NOT tgisinternal;
