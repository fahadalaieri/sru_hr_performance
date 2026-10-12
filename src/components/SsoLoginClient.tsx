"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/config";

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
declare global {
  interface Window {
    SRUSSO?: {
      init: (opts: { appId: string; appName?: string; onReady?: (user: unknown) => void; onDenied?: (info: unknown) => void }) => Promise<unknown>;
      assertion: () => Promise<string | null>;
      signOut: (redirectTo?: string) => void;
    };
  }
}

const LIBRARY_SRC = "https://dt.sr.edu.sa/sso/v1/sru-sso.js";

type Phase = "loading" | "gate" | "exchanging" | "error";
type ErrorKey = "sso_disabled" | "invalid_assertion" | "replayed" | "no_profile" | "inactive" | "rate_limited" | "unknown" | "no_assertion" | "denied" | "library";

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

    const exchange = async () => {
      setPhase("exchanging");
      const token = await window.SRUSSO?.assertion();
      if (!token) return fail("no_assertion");
      const res = await fetch("/api/sso/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assertion: token, locale }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; redirect?: string; error?: ErrorKey };
      if (res.ok && body.ok && body.redirect) {
        window.location.assign(body.redirect);
        return;
      }
      fail(body.error ?? "unknown");
    };

    const start = () => {
      if (!window.SRUSSO) return fail("library");
      setPhase("gate");
      window.SRUSSO.init({
        appId: appKey,
        appName,
        onReady: () => { void exchange(); },
        onDenied: () => fail("denied"),
      }).catch(() => fail("library"));
    };

    if (window.SRUSSO) {
      start();
      return;
    }
    const script = document.createElement("script");
    script.src = LIBRARY_SRC;
    script.async = true;
    script.onload = start;
    script.onerror = () => fail("library");
    document.body.appendChild(script);
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
      <p className="sru-auth-link-row">
        <Link href="/login">{t("backToLogin")}</Link>
      </p>
    </div>
  );
}
