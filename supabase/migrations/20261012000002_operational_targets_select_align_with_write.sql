-- ============================================================================
-- 20261012000002 — مواءمة قراءة مستهدفات الموظفين مع استثناء الكتابة الإداري
-- ============================================================================
-- المشكلة (مراجعة Codex 2026-10-12 للإصلاح 5):
--   20261007000002 جعلت القراءة مقيَّدة بالنطاق عبر check_vpra، بينما سياستا
--   INSERT/UPDATE (20260823000001) تحتفظان بفرع check_vpra_global(approve)
--   المتجاهل للنطاق. حامل approve بنطاق وحدة يستطيع تعديل حصص خارج نطاقه ولا
--   يراها — والصفحة تعرض له الحصة قابلة للإدارة بلا موظفين، وإجراء استبدال
--   التوزيع قد يترك توزيعًا قديمًا مخفيًا.
--
-- الإصلاح: إضافة فرع check_vpra_global('strategicPlanning','approve') إلى
--   القراءة، فتتطابق القراءة مع الكتابة حرفيًا. لا توسيع آخر: view وrecommend
--   يبقيان مقيَّدين بالنطاق، والموظف ورئيسه كما هما.
--
-- التراجع (Rollback): إعادة تعريف السياسة بنص 20261007000002.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS operational_plan_target_employees_select ON operational_plan_target_employees;
CREATE POLICY operational_plan_target_employees_select ON operational_plan_target_employees
  FOR SELECT TO authenticated
  USING (
    employee_id = (SELECT id FROM profiles WHERE auth_user_id = auth.uid())
    OR is_my_direct_report(employee_id)
    OR is_my_subordinate(employee_id)
    OR check_vpra_global('strategicPlanning'::process_area, 'approve'::vpra_level)
    OR check_vpra(
      'strategicPlanning'::process_area,
      'view'::vpra_level,
      (SELECT u.org_unit_id FROM operational_plan_target_org_units u WHERE u.id = operational_plan_target_employees.target_org_unit_id)
    )
  );

COMMENT ON POLICY operational_plan_target_employees_select ON operational_plan_target_employees IS
  'الموظف نفسه، أو رئيسه في السلسلة، أو strategicPlanning>=approve (نفس استثناء الكتابة)، أو strategicPlanning>=view بنطاق يشمل الوحدة (20261012000002).';

COMMIT;

-- تحقّق: SELECT qual FROM pg_policies WHERE policyname='operational_plan_target_employees_select'; -- يحوي check_vpra_global وcheck_vpra معًا
