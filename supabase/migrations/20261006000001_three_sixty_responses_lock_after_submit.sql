-- ============================================================================
-- 20261006000001 — قفل إجابات تقييم 360 بعد الإرسال
-- ============================================================================
-- المشكلة (اكتُشفت في مراجعة مستقلة 2026-10-05):
--   سياستا three_sixty_responses_insert/_update (20260902000002) تسمحان للمقيّم
--   بالكتابة ما دامت حالة التكليف ليست 'excluded'. أي أن تكليفًا حالته
--   'submitted' يبقى قابلًا للتعديل، فيستطيع المقيّم (أو حامل رابط المقيّم
--   الخارجي) تغيير إجاباته بعد أن اعتُمدت نهائيًا وحُسبت في التقرير.
--   الواجهة كانت تقفل الحقول عند status <> 'pending' (readOnly)، لكن إخفاء
--   الواجهة ليس حماية (PROJECT_STRICT قاعدة 16).
--
-- الإصلاح:
--   فرع المقيّم في السياستين يشترط a.status = 'pending' بدل a.status <> 'excluded'.
--   enum three_sixty_assignment_status هو ('pending','submitted','excluded')، فالشرط
--   الجديد يرفض 'submitted' و'excluded' معًا، ويبقي 'pending' وحدها قابلة للكتابة —
--   وهو بالضبط ما تفترضه إجراءات الإرسال (submit) التي تشترط 'pending' أصلًا.
--
-- لم يتغيّر عمدًا:
--   فرع check_vpra_global('threeSixty','approve') يبقى كما هو — صلاحية إدارية
--   للتصحيح، وإلغاؤها قرار منتج منفصل لا يُتخذ داخل إصلاح أمني ضيق.
--   سياسة SELECT لم تُمسّ.
--
-- التراجع (Rollback):
--   إعادة تعريف السياستين بالنص الأصلي من 20260902000002 (a.status <> 'excluded').
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS three_sixty_responses_insert ON three_sixty_responses;
CREATE POLICY three_sixty_responses_insert ON three_sixty_responses
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM three_sixty_assignments a
      WHERE a.id = three_sixty_responses.assignment_id
        AND a.rater_employee_id = (SELECT id FROM profiles WHERE auth_user_id = auth.uid())
        AND a.status = 'pending'
    )
    OR check_vpra_global('threeSixty'::process_area, 'approve'::vpra_level)
  );

DROP POLICY IF EXISTS three_sixty_responses_update ON three_sixty_responses;
CREATE POLICY three_sixty_responses_update ON three_sixty_responses
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM three_sixty_assignments a
      WHERE a.id = three_sixty_responses.assignment_id
        AND a.rater_employee_id = (SELECT id FROM profiles WHERE auth_user_id = auth.uid())
        AND a.status = 'pending'
    )
    OR check_vpra_global('threeSixty'::process_area, 'approve'::vpra_level)
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM three_sixty_assignments a
      WHERE a.id = three_sixty_responses.assignment_id
        AND a.rater_employee_id = (SELECT id FROM profiles WHERE auth_user_id = auth.uid())
        AND a.status = 'pending'
    )
    OR check_vpra_global('threeSixty'::process_area, 'approve'::vpra_level)
  );

COMMENT ON POLICY three_sixty_responses_insert ON three_sixty_responses IS
  'المقيّم يكتب إجاباته ما دام تكليفه pending فقط (20261006000001)؛ approve على threeSixty يتجاوز للتصحيح الإداري.';
COMMENT ON POLICY three_sixty_responses_update ON three_sixty_responses IS
  'المقيّم يعدّل إجاباته ما دام تكليفه pending فقط (20261006000001)؛ approve على threeSixty يتجاوز للتصحيح الإداري.';

COMMIT;

-- ============================================================================
-- تحقّق — يُشغَّل بعد التطبيق (PROJECT_STRICT قاعدة 10).
-- ============================================================================
-- المتوقع: صفّان، وكلاهما يحوي "status = 'pending'" ولا يحوي "<> 'excluded'".
-- SELECT policyname, cmd, qual, with_check FROM pg_policies
-- WHERE tablename = 'three_sixty_responses' AND policyname IN
--   ('three_sixty_responses_insert', 'three_sixty_responses_update');
