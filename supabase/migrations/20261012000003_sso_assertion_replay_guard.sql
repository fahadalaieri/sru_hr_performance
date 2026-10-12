-- ============================================================================
-- 20261012000003 — حارس إعادة الاستخدام لتصاريح الدخول الموحّد
-- ============================================================================
-- السياق: الدخول بحساب الجامعة عبر SRU SSO (dt.sr.edu.sa/sso/v1). منصّة
-- الهوية تُصدر تصريحًا موقّعًا (JWT HS256، عمره 60 ثانية، aud = معرّف هذه
-- المنصّة، jti فريد) يحمله المتصفّح إلى /api/sso/callback هنا، فنتحقّق من
-- التوقيع ونُصدر جلستنا نحن. عقد التكامل يشترط ألّا يُقبل jti مرّتين.
--
-- هذا الجدول يسجّل كل jti قُبل حتى انقضائه. يكتبه الخادم بصلاحية الخدمة
-- وحده: RLS مفعّل بلا سياسات، ومنح anon/authenticated مسحوبة (هذا المشروع
-- يمنحهما كل جدول جديد عبر ALTER DEFAULT PRIVILEGES، فالسحب الصريح لازم).
--
-- التراجع: DROP TABLE sso_assertion_jti;
-- ============================================================================

BEGIN;

CREATE TABLE sso_assertion_jti (
  jti        UUID PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sso_assertion_jti IS
  'تصاريح الدخول الموحّد المستهلَكة (jti) حتى انقضائها — يمنع إعادة استخدام تصريح واحد مرّتين. يكتبه الخادم بصلاحية الخدمة فقط (20261012000003).';

CREATE INDEX sso_assertion_jti_expires_idx ON sso_assertion_jti (expires_at);

ALTER TABLE sso_assertion_jti ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sso_assertion_jti FROM PUBLIC;
REVOKE ALL ON TABLE sso_assertion_jti FROM anon;
REVOKE ALL ON TABLE sso_assertion_jti FROM authenticated;

COMMIT;

-- تحقّق: SELECT rowsecurity FROM pg_tables WHERE tablename='sso_assertion_jti'; -- t
--        SELECT grantee FROM information_schema.role_table_grants WHERE table_name='sso_assertion_jti'; -- بلا anon/authenticated
