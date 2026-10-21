-- ============================================================================
-- 20261021000001 — تقاعد بنك الأهداف وإسناد الأهداف والقوالب الافتراضية
-- ============================================================================
-- القرار (فهد 2026-10-21، تحليل الفجوات §2-ب و§4 بند 6): بنك الأهداف وإسناد
-- الأهداف والقوالب الافتراضية مجالات صلاحية بلا شاشات حقيقية، والأهداف
-- (`goals`) أُخرجت من الدرجة الموزونة عمدًا في 20260828000001، ومستهدفات
-- الموظف الحقيقية تأتي من الخطط التشغيلية. تُقاعد المجالات الثلاثة:
--   (1) تُحذف منحها من role_permissions فلا تظهر في مصفوفة الصلاحيات ولا تمنح شيئًا؛
--   (2) تُسحب صلاحيات anon/authenticated عن goal_library وgoals فلا تُقرأ ولا تُكتب
--       عبر الواجهة (RLS تبقى، والجداول تبقى تاريخًا — صفر صفوف في التطوير؛
--       حذفها قرار منفصل عند دمج الإنتاج)؛
--   (3) قيم enum process_area تبقى (حذف قيمة enum يتطلب إعادة بناء النوع
--       وكل ما يعتمد عليه؛ لا يستحق). التطبيق لم يعد يعرضها (src/lib/vpra.ts).
-- evaluation_scores.goal_id يبقى (لا درجات عليه).
--
-- التراجع (Rollback): إعادة منح GRANT SELECT/INSERT/UPDATE لـauthenticated على
-- الجدولين، وإعادة صفوف role_permissions من البذرة 20260716000007.
-- ============================================================================

BEGIN;

DELETE FROM role_permissions
 WHERE process_area IN ('goalsLibrary'::process_area, 'goalAssignment'::process_area, 'defaultTemplates'::process_area);

REVOKE ALL ON goal_library FROM anon, authenticated;
REVOKE ALL ON goals FROM anon, authenticated;

COMMENT ON TABLE goal_library IS 'متقاعد 2026-10-21: بنك الأهداف لم يُبنَ له شاشات والأهداف خارج الدرجة؛ الجدول محفوظ تاريخًا بلا صلاحيات واجهة.';
COMMENT ON TABLE goals IS 'متقاعد 2026-10-21: مستهدفات الموظف تأتي من الخطط التشغيلية (operational_plan_target_employees)؛ الجدول محفوظ تاريخًا بلا صلاحيات واجهة.';

SELECT count(*) AS remaining_grants FROM role_permissions
 WHERE process_area IN ('goalsLibrary'::process_area, 'goalAssignment'::process_area, 'defaultTemplates'::process_area);

COMMIT;
