// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { ProfileTabs, type ProfileTab } from "./ProfileTabs";

// Regression test for the hydration mismatch reported 2026-10-21: the server
// has no URL hash, so it always renders the first tab active; if the client's
// FIRST render reads window.location.hash instead, aria-selected/className and
// the panel content differ between server and client and React logs a
// hydration error on every `/profile#<id>`-style link. The fix must keep the
// first client render identical to the server's and only then apply the hash.

const tabs: ProfileTab[] = [
  { id: "my-data", label: "بياناتي", content: <p>panel-my-data</p> },
  { id: "my-kpis", label: "مؤشراتي", content: <p>panel-my-kpis</p> },
  { id: "my-tasks", label: "مهامي", content: <p>panel-my-tasks</p> },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  window.history.replaceState(null, "", window.location.pathname);
  vi.restoreAllMocks();
});

async function hydrateWithHash(hash: string) {
  // 1. Server render: no window hash exists there, so `renderToString` runs
  //    with the hash cleared to reproduce the real SSR output exactly.
  window.history.replaceState(null, "", window.location.pathname);
  const serverHtml = renderToString(<ProfileTabs tabs={tabs} />);

  // 2. The browser then navigates to the URL WITH the hash and hydrates the
  //    server markup in place.
  window.location.hash = hash;
  container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.appendChild(container);

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const recoverable: unknown[] = [];
  await act(async () => {
    root = hydrateRoot(container!, <ProfileTabs tabs={tabs} />, {
      onRecoverableError: (error) => recoverable.push(error),
    });
  });

  return { consoleError, recoverable };
}

describe("ProfileTabs hydration with a URL hash", () => {
  it("server markup marks the first tab active (the baseline the client must match)", () => {
    window.location.hash = "#my-kpis";
    const html = renderToString(<ProfileTabs tabs={tabs} />);
    expect(html).toContain("panel-my-data");
    expect(html).not.toContain("panel-my-kpis");
  });

  it("hydrates without a hydration error when the URL carries a hash", async () => {
    const { consoleError, recoverable } = await hydrateWithHash("#my-kpis");

    const hydrationLogs = consoleError.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === "string" && /hydrat/i.test(arg))
    );
    expect(hydrationLogs).toEqual([]);
    expect(recoverable).toEqual([]);
  });

  it("still selects the hash's tab once mounted", async () => {
    await hydrateWithHash("#my-kpis");

    const selected = container!.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe("مؤشراتي");
    expect(container!.querySelector('[role="tabpanel"]')?.textContent).toBe("panel-my-kpis");
  });

  it("falls back to the first tab for an unknown hash", async () => {
    await hydrateWithHash("#does-not-exist");

    const selected = container!.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe("بياناتي");
  });
});
