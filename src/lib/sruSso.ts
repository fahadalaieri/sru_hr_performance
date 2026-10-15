/**
 * Browser-side helpers around the university's central SSO library
 * (https://dt.sr.edu.sa/sso/v1/sru-sso.js). The library is never copied
 * locally — the SSO contract requires loading the one central script — so
 * these helpers only load it on demand and expose what this platform needs.
 *
 * Client components only (window / localStorage).
 */
declare global {
  interface Window {
    SRUSSO?: {
      init: (opts: { appId: string; appName?: string; onReady?: (user: unknown) => void; onDenied?: (info: unknown) => void }) => Promise<unknown>;
      assertion: () => Promise<string | null>;
      /** Ends the university identity session in this origin's storage, then navigates to `redirectTo` (or reloads). Works without `init`. */
      signOut: (redirectTo?: string) => Promise<void> | void;
    };
  }
}

export const SRU_SSO_LIBRARY_SRC = "https://dt.sr.edu.sa/sso/v1/sru-sso.js";

/** Loads the central library once and resolves with `window.SRUSSO`, or null when it cannot be loaded. */
export function loadSruSsoLibrary(): Promise<NonNullable<Window["SRUSSO"]> | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.SRUSSO) return Promise.resolve(window.SRUSSO);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = SRU_SSO_LIBRARY_SRC;
    script.async = true;
    script.onload = () => resolve(window.SRUSSO ?? null);
    script.onerror = () => resolve(null);
    document.body.appendChild(script);
  });
}

/**
 * Whether the university identity session is still stored in this origin.
 * The SSO library's supabase-js client persists it in localStorage under
 * `sb-<identity ref>-auth-token`; this platform's own session lives in
 * cookies (@supabase/ssr), never in localStorage, so any such key is the
 * identity session. It outlives this platform's sign-out (SSO INSTALL.md:
 * "do not clear your own storage and think you signed the user out"), so a
 * sign-out that ignores it re-enters the same person on the next SSO visit.
 */
export function hasUniversityIdentitySession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) ?? "";
      if (/^sb-.+-auth-token$/.test(key)) return true;
    }
  } catch {
    /* storage blocked: treat as no session */
  }
  return false;
}
