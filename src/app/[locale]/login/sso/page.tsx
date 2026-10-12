import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { isLocale, getDir, type Locale } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import { SsoLoginClient } from "@/components/SsoLoginClient";
import { LoginArtwork } from "@/components/LoginArtwork";

/**
 * /login/sso — the university single sign-on hand-off (2026-10-12). Sibling of
 * /login, outside (app)/ so no session is required to reach it. The SSO
 * library returns the user to the page that started the sign-in, so this page
 * is both the start and the landing of the flow and continues it on load.
 *
 * Rendered only when the platform is registered with the SSO operator
 * (NEXT_PUBLIC_SRU_SSO_APP_KEY); otherwise it points back to the login form,
 * since a gate that can never succeed is worse than no gate.
 */
export default async function SsoLoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : "ar";
  const t = await getTranslations("SsoPage");
  const appKey = process.env.NEXT_PUBLIC_SRU_SSO_APP_KEY;
  const appName = process.env.NEXT_PUBLIC_SRU_SSO_APP_NAME ?? "برنامج إدارة الأداء";

  return (
    <main className="sru-auth-split" dir={getDir(locale)}>
      <section className="sru-auth-split-form">
        {appKey ? (
          <SsoLoginClient locale={locale} appKey={appKey} appName={appName} />
        ) : (
          <div className="sru-auth-split-inner">
            <h1>{t("title")}</h1>
            <p className="sru-auth-split-lead">{t("errors.sso_disabled")}</p>
            <p className="sru-auth-link-row">
              <Link href="/login">{t("backToLogin")}</Link>
            </p>
          </div>
        )}
      </section>
      <aside className="sru-auth-split-art">
        <div className="sru-auth-art-brand">
          <Image src="/logo-white.png" alt="شعار جامعة سليمان الراجحي" width={132} height={68} priority />
          <span>{appName}</span>
        </div>
        <LoginArtwork />
      </aside>
    </main>
  );
}
