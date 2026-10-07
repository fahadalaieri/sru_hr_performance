-- ============================================================================
-- 20261007000002 — تضييق قراءة مستهدفات الموظفين، وتفعيل RLS على جدول الأرشيف
-- ============================================================================
-- المشكلة (مراجعة 2026-10-05، الأولوية السادسة):
--   (1) operational_plan_target_employees_select كانت USING (true) لكل مستخدم
--       مصادَق (ورثتها من 20260823000001 حين كان الجدول executive_plan_target_
--       employees). الجدول يحمل نسبة كل موظف من مستهدف وحدته والقيمة الفعلية
--       التي حققها — بيانات أداء شخصية، لا «الخطة التي يُطلب من الجميع
--       تنفيذها» كما تصف الجداول الأعلى. أي موظف كان يقرأ أرقام زملائه كلهم.
--   (2) org_units_kind_backup (20260831000003) أُنشئ بلا RLS، وبحكم ALTER DEFAULT
--       PRIVILEGES في هذا المشروع ورث منح SELECT/INSERT/UPDATE/DELETE لـ anon
--       وauthenticated — أي أنه مقروء وقابل للكتابة عبر PostgREST من أي زائر.
--
-- الإصلاح:
--   (1) السياسة الجديدة تسمح بالقراءة لأحد خمسة:
--       - الموظف نفسه (صاحب الصف)؛
--       - رئيسه المباشر أو أي رئيس في سلسلته (is_my_direct_report /
--         is_my_subordinate، الدالتان القائمتان، 20260718000009 و20260725000008)؛
--       - من يملك strategicPlanning >= view بنطاق يشمل الوحدة صاحبة الحصة
--         (check_vpra المقيَّد: دور بنطاق all يمرّ، ودور بنطاق org_unit يمرّ
--         فقط إن كانت الوحدة داخل نطاقه عبر is_org_unit_in_scope).
--       لا يُستخدم check_vpra_global هنا عمدًا: هذا الجدول له وحدة لكل صف،
--       وcheck_vpra_global يتجاهل النطاق كليًا فكان سيُمرّر مديرًا مقيَّدًا
--       بوحدة أخرى — اكتُشف ذلك بالمحاكاة قبل الاعتماد (M2 رأى صفًا ليس في نطاقه).
--       سياسات INSERT/UPDATE لم تُمسّ.
--   (2) تفعيل RLS على جدول الأرشيف بلا أي سياسة (رفض افتراضي) وسحب كل المنح من
--       anon وauthenticated. يبقى مقروءًا لمالك القاعدة وservice_role فقط،
--       وهو ما يحتاجه «أرشيف للرجوع عند الحاجة».
--
-- التراجع (Rollback):
--   (1) DROP POLICY ... ; CREATE POLICY operational_plan_target_employees_select
--       ON operational_plan_target_employees FOR SELECT TO authenticated USING (true);
--   (2) ALTER TABLE org_units_kind_backup DISABLE ROW LEVEL SECURITY;
--       GRANT SELECT ON org_units_kind_backup TO authenticated;
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS operational_plan_target_employees_select ON operational_plan_target_employees;
CREATE POLICY operational_plan_target_employees_select ON operational_plan_target_employees
  FOR SELECT TO authenticated
  USING (
    employee_id = (SELECT id FROM profiles WHERE auth_user_id = auth.uid())
    OR is_my_direct_report(employee_id)
    OR is_my_subordinate(employee_id)
    OR check_vpra(
      'strategicPlanning'::process_area,
      'view'::vpra_level,
      (SELECT u.org_unit_id FROM operational_plan_target_org_units u WHERE u.id = operational_plan_target_employees.target_org_unit_id)
    )
  );

COMMENT ON POLICY operational_plan_target_employees_select ON operational_plan_target_employees IS
  'الموظف نفسه، أو رئيسه في السلسلة، أو حامل strategicPlanning>=view بنطاق يشمل الوحدة صاحبة الحصة (20261007000002).';

ALTER TABLE org_units_kind_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE org_units_kind_backup FROM anon;
REVOKE ALL ON TABLE org_units_kind_backup FROM authenticated;
REVOKE ALL ON TABLE org_units_kind_backup FROM PUBLIC;

COMMENT ON TABLE org_units_kind_backup IS
  'أرشيف قيم org_units.kind قبل حذف العمود (20260831000003). RLS مفعّل بلا سياسات ومنح anon/authenticated مسحوبة (20261007000002): مقروء لمالك القاعدة وservice_role فقط.';

COMMIT;

-- تحقّق — يُشغَّل بعد التطبيق:
-- SELECT qual FROM pg_policies WHERE policyname = 'operational_plan_target_employees_select';  -- لا يحوي "true" وحدها
-- SELECT rowsecurity FROM pg_tables WHERE tablename = 'org_units_kind_backup';               -- t
-- SELECT grantee FROM information_schema.role_table_grants WHERE table_name = 'org_units_kind_backup'; -- بلا anon/authenticated
