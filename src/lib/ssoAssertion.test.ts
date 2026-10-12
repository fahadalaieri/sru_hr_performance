import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySsoAssertion, parseAssertionSecrets } from "./ssoAssertion";

const APP = "hr-performance";
const SECRETS = { v1: "old-secret-value", v2: "current-secret-value" };
const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function sign(payload: Record<string, unknown>, kid = "v2", secret = SECRETS[kid as keyof typeof SECRETS] ?? "x") {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid }));
  const body = `${header}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
const now = 1_800_000_000;
const good = () => ({ iss: "sru-sso", aud: APP, sub: "11111111-1111-4111-8111-111111111111", email: "Fahad@SR.edu.sa", name: "فهد", role: "viewer", iat: now - 5, exp: now + 55, jti: "22222222-2222-4222-8222-222222222222" });

describe("parseAssertionSecrets", () => {
  it("reads a JSON map of kid → secret", () => {
    expect(parseAssertionSecrets('{"v1":"a","v2":"b"}')).toEqual({ v1: "a", v2: "b" });
  });
  it("returns an empty map for a missing or malformed value", () => {
    expect(parseAssertionSecrets(undefined)).toEqual({});
    expect(parseAssertionSecrets("not json")).toEqual({});
  });
});

describe("verifySsoAssertion", () => {
  it("accepts a valid assertion and returns the lower-cased email and claims", () => {
    const r = verifySsoAssertion(sign(good()), { appKey: APP, secrets: SECRETS, nowSeconds: now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.email).toBe("fahad@sr.edu.sa");
      expect(r.claims.jti).toBe(good().jti);
      expect(r.claims.exp).toBe(now + 55);
    }
  });

  it("accepts a token signed with an older kid still present in the map (rotation overlap)", () => {
    const r = verifySsoAssertion(sign(good(), "v1"), { appKey: APP, secrets: SECRETS, nowSeconds: now });
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown kid", () => {
    const r = verifySsoAssertion(sign(good(), "v9", "whatever"), { appKey: APP, secrets: SECRETS, nowSeconds: now });
    expect(r).toEqual({ ok: false, reason: "unknown_kid" });
  });

  it("rejects a bad signature", () => {
    const r = verifySsoAssertion(sign(good(), "v2", "wrong"), { appKey: APP, secrets: SECRETS, nowSeconds: now });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token addressed to another app", () => {
    const r = verifySsoAssertion(sign({ ...good(), aud: "majlis" }), { appKey: APP, secrets: SECRETS, nowSeconds: now });
    expect(r).toEqual({ ok: false, reason: "wrong_audience" });
  });

  it("rejects a wrong issuer", () => {
    const r = verifySsoAssertion(sign({ ...good(), iss: "someone" }), { appKey: APP, secrets: SECRETS, nowSeconds: now });
    expect(r).toEqual({ ok: false, reason: "wrong_issuer" });
  });

  it("rejects an expired token, allowing a small clock skew", () => {
    expect(verifySsoAssertion(sign({ ...good(), exp: now - 30 }), { appKey: APP, secrets: SECRETS, nowSeconds: now })).toEqual({ ok: false, reason: "expired" });
    expect(verifySsoAssertion(sign({ ...good(), exp: now - 5 }), { appKey: APP, secrets: SECRETS, nowSeconds: now }).ok).toBe(true);
  });

  it("rejects a token whose lifetime is longer than the SSO contract's 60 seconds", () => {
    const r = verifySsoAssertion(sign({ ...good(), exp: now + 3600 }), { appKey: APP, secrets: SECRETS, nowSeconds: now });
    expect(r).toEqual({ ok: false, reason: "lifetime_too_long" });
  });

  it("rejects malformed input and non-HS256 headers", () => {
    expect(verifySsoAssertion("abc", { appKey: APP, secrets: SECRETS, nowSeconds: now })).toEqual({ ok: false, reason: "malformed" });
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT", kid: "v2" }));
    const body = `${header}.${b64url(JSON.stringify(good()))}`;
    expect(verifySsoAssertion(`${body}.`, { appKey: APP, secrets: SECRETS, nowSeconds: now })).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a token missing email or jti", () => {
    const { email: _e, ...noEmail } = good();
    void _e;
    expect(verifySsoAssertion(sign(noEmail), { appKey: APP, secrets: SECRETS, nowSeconds: now })).toEqual({ ok: false, reason: "malformed" });
  });
});
