"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, LogOut } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/config";
import { loadSruSsoLibrary } from "@/lib/sruSso";

/**
 * The university SSO hand-off page body. Loads the central library exactly as
 * the SSO contract requires (one script, never copied locally, auto-loads its
 * own supabase-js), lets it draw the sign-in gate, and — once the identity
 * project reports the user — asks it for a 60-second assertion addressed to
 * this platform and posts that to /api/sso/callback, which issues our session.
 *
 * This lives on its own route (/login/sso) rather than on the login form: the
 * SSO return lands on the page that started the sign-in, so that page must
 * continue the flow on plain load with no click.
 */
type Phase = "loading" | "gate" | "exchanging" | "error";
type ErrorKey = "sso_disabled" | "invalid_assertion" | "replayed" | "no_profile" | "profile_pending" | "inactive" | "rate_limited" | "unknown" | "no_assertion" | "denied" | "library";

/** The directory hints the SSO library exposes on its user object (unsigned; the server treats them as hints only). */
type SsoUser = { nameAr?: string | null; department?: string | null; positionAr?: string | null };

export function SsoLoginClient({ locale, appKey, appName }: { locale: Locale; appKey: string; appName: string }) {
  const t = useTranslations("SsoPage");
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const fail = (key: ErrorKey) => {
      setErrorKey(key);
      setPhase("error");
    };

    const exchange = async (user: SsoUser | null) => {
      setPhase("exchanging");
      const token = await window.SRUSSO?.assertion();
      if (!token) return fail("no_assertion");
      const directory = user ? { nameAr: user.nameAr ?? null, department: user.department ?? null, positionAr: user.positionAr ?? null } : undefined;
      const res = await fetch("/api/sso/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assertion: token, locale, directory }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; redirect?: string; error?: ErrorKey };
      if (res.ok && body.ok && body.redirect) {
        window.location.assign(body.redirect);
        return;
      }
      fail(body.error ?? "unknown");
    };

    void loadSruSsoLibrary().then((sso) => {
      if (!sso) return fail("library");
      setPhase("gate");
      sso.init({
        appId: appKey,
        appName,
        onReady: (user) => { void exchange((user as SsoUser | null) ?? null); },
        onDenied: () => fail("denied"),
      }).catch(() => fail("library"));
    });
  }, [appKey, appName, locale]);

  return (
    <div className="sru-auth-split-inner" aria-live="polite">
      <h1>{t("title")}</h1>
      {phase === "loading" && <p className="sru-auth-split-lead">{t("loading")}</p>}
      {phase === "gate" && <p className="sru-auth-split-lead">{t("gate")}</p>}
      {phase === "exchanging" && <p className="sru-auth-split-lead">{t("exchanging")}</p>}
      {phase === "error" && errorKey && (
        <p role="alert" className="sru-auth-alert error">
          <AlertCircle size={15} aria-hidden />
          {t(`errors.${errorKey}`)}
        </p>
      )}
      {/* The university identity session lives in this origin's storage and
          outlives any answer this platform gives (SSO INSTALL.md: a user who
          signed in with the wrong account "stays stuck in it"). Without this
          button a denied user could never try another university account:
          the next visit silently continues as the same person. SRUSSO.signOut
          clears that session and returns to the password login page. */}
      {phase === "error" && (
        <div className="sru-auth-sso">
          <button type="button" className="sru-btn sru-btn-secondary sru-auth-sso-btn" onClick={() => void window.SRUSSO?.signOut(`/${locale}/login`)}>
            <LogOut size={16} aria-hidden />
            {t("switchAccount")}
          </button>
        </div>
      )}
      <p className="sru-auth-link-row">
        <Link href="/login">{t("backToLogin")}</Link>
      </p>
    </div>
  );
}
