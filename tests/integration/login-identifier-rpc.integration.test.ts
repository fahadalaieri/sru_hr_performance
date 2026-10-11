import { describe, expect, it } from "vitest";
import { adminClient, anonClient, hasDatabase } from "./helpers";

/** resolve_login_identifier is service-role only since 20261007000001. */
describe.skipIf(!hasDatabase)("resolve_login_identifier grants", () => {
  it("anon cannot call it (no username enumeration through PostgREST)", async () => {
    const r = await anonClient().rpc("resolve_login_identifier", { p_identifier: "admin" });
    expect(r.error?.code).toBe("42501");
  });

  it("service_role resolves a known username and returns null for an unknown one", async () => {
    const admin = adminClient();
    const known = await admin.rpc("resolve_login_identifier", { p_identifier: "an-email@example.org" });
    expect(known.error).toBeNull();
    expect(known.data).toBe("an-email@example.org"); // email-shaped identifiers pass through
    const unknown = await admin.rpc("resolve_login_identifier", { p_identifier: `no-such-user-${Date.now()}` });
    expect(unknown.error).toBeNull();
    expect(unknown.data).toBeNull();
  });
});
