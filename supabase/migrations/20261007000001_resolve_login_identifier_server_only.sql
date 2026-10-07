-- ============================================================================
-- 20261007000001 — قصر resolve_login_identifier على الخادم
-- ============================================================================
-- المشكلة (مراجعة 2026-10-05، الأولوية الرابعة):
--   الدالة SECURITY DEFINER وممنوحة لـ anon منذ 20260725000010 لأن الدخول يسبق
--   المصادقة. لكن ذلك يعني أن أي زائر بلا حساب يستطيع استدعاءها مباشرة عبر
--   PostgREST (بمفتاح anon العام) وتجربة أسماء مستخدمين: اسمٌ موجود يُرجع بريده
--   الحقيقي، وغير الموجود يُرجع NULL — تعداد للحسابات وكشف للبريد، خارج أي حدّ
--   معدل، لأن حدّ المعدل يعيش في إجراء الدخول لا في الدالة.
--
-- الإصلاح:
--   تُسحب EXECUTE من anon وauthenticated، وتبقى لـ service_role فقط. إجراء الدخول
--   (src/app/[locale]/login/actions.ts) صار يستدعيها بعميل الخدمة بعد حدّ المعدل،
--   فتبقى تجربة الدخول باسم المستخدم كما هي دون أي مسار عام للتعداد.
--   لا تعديل على جسم الدالة.
--
-- التراجع (Rollback):
--   GRANT EXECUTE ON FUNCTION resolve_login_identifier(TEXT) TO anon, authenticated;
-- ============================================================================

BEGIN;

REVOKE EXECUTE ON FUNCTION resolve_login_identifier(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_login_identifier(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION resolve_login_identifier(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION resolve_login_identifier(TEXT) TO service_role;

COMMENT ON FUNCTION resolve_login_identifier IS
  'Resolves a login-form identifier (email or username) to the real email signInWithPassword needs. SECURITY DEFINER, callable by service_role ONLY (20261007000001): the login Server Action calls it after rate limiting, so no public PostgREST path can enumerate usernames or read emails. Returns NULL silently on no match.';

COMMIT;

-- تحقّق — يُشغَّل بعد التطبيق:
-- المتوقع: service_role فقط (وpostgres المالك).
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
-- WHERE routine_name = 'resolve_login_identifier';
