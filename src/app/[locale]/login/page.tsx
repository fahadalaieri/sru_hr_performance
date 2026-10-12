import Image from "next/image";
import { Globe } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { locales, isLocale, getDir, type Locale } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import { LoginForm } from "@/components/LoginForm";
import { LoginArtwork } from "@/components/LoginArtwork";

/**
 * Two columns: the form on one side, an illustrated panel on the other
 * (2026-08-24, following a reference layout the project owner sent).
 *
 * The brand lockup lives on the illustrated panel (2026-08-29, requested):
 * the logo already carries the university's name in both languages, so
 * repeating it as text beside the form said the same thing twice. What sits
 * under the logo now is what this system IS — برنامج إدارة الأداء — which the
 * logo cannot say.
 *
 * Two things in the original reference are deliberately NOT here, because they
 * would be controls that do nothing:
 *
 *  - "Continue with Google". No Google provider is configured for this
 *    project; sign-in is Supabase email/username + password.
 *  - "Get started, it's free" and a sign-up link. Accounts here are created by
 *    HR and sent as an invite (SECURITY_CHECKLIST 1.7 — signup disabled), so
 *    that slot says how to obtain an account instead of offering to create one.
 */
export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : "ar";
  const otherLocale = locales.find((l) => l !== locale) ?? locale;
  const otherLocaleLabel = locale === "ar" ? "English" : "العربية";
  const t = await getTranslations("LoginPage");

  return (
    <main className="sru-auth-split" dir={getDir(locale)}>
      {/* A globe + the target language's own name: what the control does is
          legible before reading it, and the label stays in the language being
          switched TO, which is how every locale switch should read. */}
      <Link
        href="/login"
        locale={otherLocale}
        className="sru-auth-locale"
        aria-label={t("switchLanguage", { language: otherLocaleLabel })}
      >
        <Globe size={15} aria-hidden />
        <span>{otherLocaleLabel}</span>
      </Link>

      <section className="sru-auth-split-form">
        <div className="sru-auth-split-inner">
          <h1>{t("welcomeTitle")}</h1>
          <p className="sru-auth-split-lead">{t("welcomeLead")}</p>

          <LoginForm locale={locale} />

          {/* University SSO (2026-10-12): shown only once this platform is
              registered with the SSO operator — a button that can never
              succeed is worse than none. The hand-off lives on /login/sso. */}
          {process.env.NEXT_PUBLIC_SRU_SSO_APP_KEY && (
            <div className="sru-auth-sso">
              <p className="sru-auth-sso-divider"><span>{t("ssoDivider")}</span></p>
              <Link href="/login/sso" className="sru-btn sru-auth-sso-btn">
                <Globe size={16} aria-hidden />
                {t("ssoButton")}
              </Link>
              <p className="sru-auth-split-note">{t("ssoHint")}</p>
            </div>
          )}

          <p className="sru-auth-split-note">{t("inviteNote")}</p>
        </div>
      </section>

      <aside className="sru-auth-split-art">
        <div className="sru-auth-art-brand">
          {/* The white mark, as on the app's own dark topbar — the colour
              version would need a white plate on this gradient. */}
          <Image src="/logo-white.png" alt={t("logoAlt")} width={132} height={68} priority />
          <span>{t("programName")}</span>
        </div>
        <LoginArtwork />
      </aside>
    </main>
  );
}
