import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the signed assertion the university SSO (`dt.sr.edu.sa/sso/v1`)
 * mints for THIS platform — see `docs/sso/sql/sso_004_assertion.sql` in the
 * `sru-dt` repository, which is the authoritative description of the token:
 *
 *   header  { alg: "HS256", typ: "JWT", kid: "v<N>" }
 *   payload { iss: "sru-sso", aud: <app_key>, sub, email, name, role, iat, exp (= iat + 60), jti }
 *   signed with vault secret `assertion_secret_<app_key>_v<N>` (HMAC-SHA256)
 *
 * The receiving side must check: signature by the secret `kid` names, aud ==
 * its own app key, exp not passed, and jti not consumed. The last check lives
 * in the Route Handler (it needs the database); everything else is here, pure
 * and unit-tested. Nothing in the payload is trusted before the signature
 * passes.
 */

export interface SsoAssertionClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  name: string | null;
  role: string | null;
  iat: number;
  exp: number;
  jti: string;
}

export type SsoAssertionVerification =
  | { ok: true; claims: SsoAssertionClaims; kid: string }
  | { ok: false; reason: "malformed" | "unknown_kid" | "bad_signature" | "wrong_issuer" | "wrong_audience" | "expired" | "lifetime_too_long" };

export interface VerifyOptions {
  appKey: string;
  /** kid → secret, as parsed from SRU_SSO_ASSERTION_SECRETS. */
  secrets: Record<string, string>;
  nowSeconds?: number;
  /** Seconds of tolerated clock difference between the two Supabase projects. */
  clockSkewSeconds?: number;
}

const ISSUER = "sru-sso";
const MAX_LIFETIME_SECONDS = 60 + 10; // the contract's 60s plus the skew allowance

/** `SRU_SSO_ASSERTION_SECRETS='{"v1":"…","v2":"…"}'` — keep the previous kid during rotation. */
export function parseAssertionSecrets(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string" && v) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function verifySsoAssertion(token: string, options: VerifyOptions): SsoAssertionVerification {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts;

  const header = decodeSegment(h) as { alg?: unknown; kid?: unknown } | undefined;
  if (!header || header.alg !== "HS256" || typeof header.kid !== "string") return { ok: false, reason: "malformed" };

  const secret = options.secrets[header.kid];
  if (!secret) return { ok: false, reason: "unknown_kid" };

  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(s, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  // Only now is the payload worth reading.
  const payload = decodeSegment(p) as Partial<Record<keyof SsoAssertionClaims, unknown>> | undefined;
  if (!payload || typeof payload !== "object") return { ok: false, reason: "malformed" };
  const { iss, aud, sub, email, name, role, iat, exp, jti } = payload;
  if (typeof iss !== "string" || typeof aud !== "string" || typeof sub !== "string" || typeof email !== "string" || typeof jti !== "string" || typeof iat !== "number" || typeof exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (iss !== ISSUER) return { ok: false, reason: "wrong_issuer" };
  if (aud !== options.appKey) return { ok: false, reason: "wrong_audience" };

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 10;
  if (exp + skew < now) return { ok: false, reason: "expired" };
  if (exp - iat > MAX_LIFETIME_SECONDS) return { ok: false, reason: "lifetime_too_long" };

  return {
    ok: true,
    kid: header.kid,
    claims: {
      iss,
      aud,
      sub,
      email: email.trim().toLowerCase(),
      name: typeof name === "string" ? name : null,
      role: typeof role === "string" ? role : null,
      iat,
      exp,
      jti,
    },
  };
}
