"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { ChevronDown, LogOut } from "lucide-react";
import { locales, type Locale } from "@/i18n/config";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { createClient } from "@/lib/supabase/client";
import { hasUniversityIdentitySession, loadSruSsoLibrary } from "@/lib/sruSso";
import { UserMenu } from "./UserMenu";
import { NotificationsBell, type NotificationRow } from "./NotificationsBell";

const localeLabels: Record<Locale, string> = {
  ar: "عربي",
  en: "English",
};

export function TopBar({
  locale,
  userName,
  notifications = [],
  ssoEnabled = false,
}: {
  locale: Locale;
  userName?: string;
  /** The caller's own notifications, fetched server-side in (app)/layout.tsx. */
  notifications?: NotificationRow[];
  /** Whether the university SSO is configured (decided server-side from NEXT_PUBLIC_SRU_SSO_APP_KEY, like the login page). */
  ssoEnabled?: boolean;
}) {
  const t = useTranslations("TopBar");
  const pathname = usePathname();
  const router = useRouter();
  const otherLocale = locales.find((l) => l !== locale) ?? locale;

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    // A user who came in through the university SSO still holds the identity
    // session in this origin's storage; ending only our session would let the
    // next /login/sso visit re-enter silently as the same person (a shared
    // device, or someone wanting another account). The central library's
    // signOut ends that session too and then navigates to the login page.
    if (ssoEnabled && hasUniversityIdentitySession()) {
      const sso = await loadSruSsoLibrary();
      if (sso) {
        await sso.signOut(`/${locale}/login`);
        return;
      }
    }
    router.push("/login");
    router.refresh();
  };

  return (
    <header className="sru-topbar">
      <span className="sru-topbar-brand">
        <Image
          src="/logo-white.png"
          alt="جامعة سليمان الراجحي"
          width={120}
          height={26}
          style={{ height: 26, width: "auto" }}
          priority
        />
      </span>
      <div className="sru-topbar-meta">
        <NotificationsBell notifications={notifications} />
        <span className="divider" aria-hidden />
        <Link href={pathname} locale={otherLocale} className="pill">
          {localeLabels[otherLocale]}
          <ChevronDown size={13} aria-hidden />
        </Link>
        <span className="divider" aria-hidden />
        <UserMenu userName={userName} />
        <button type="button" className="sru-icon-btn" onClick={handleSignOut} aria-label={t("logout")}>
          {!userName && t("logout")}
          <LogOut size={16} aria-hidden />
        </button>
      </div>
    </header>
  );
}
