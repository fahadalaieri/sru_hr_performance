"use client";

import { useEffect, useState, type ReactNode } from "react";

export interface ProfileTab {
  id: string;
  label: string;
  content: ReactNode;
}

// Per the project owner's feedback (2026-07-22): the previous single long
// scrolling page with anchor links was "nice, but" needed to be split into
// tabs/sidebar/separate pages. Chose top tabs over new routes to avoid
// re-adding the nav clutter the earlier permission-filtering PR removed —
// TopBar's UserMenu dropdown still links to `/profile#<id>`.
//
// The initial state is ALWAYS the first tab, on the server and on the client.
// An earlier version read `window.location.hash` inside useState's lazy
// initializer to skip a render; but the server has no hash and renders the
// first tab active, so on any `/...#<id>` link the client's first render
// disagreed with the server markup (aria-selected, className and the panel
// content) and React logged a hydration-mismatch error on every such
// navigation (2026-10-21). The hash is applied in the effect below instead,
// after hydration, so server and client always agree during hydration.
export function ProfileTabs({ tabs }: { tabs: ProfileTab[] }) {
  const [activeId, setActiveId] = useState(() => tabs[0]?.id);

  // Reads the URL hash once after mount (and on back/forward) and selects
  // that tab if it exists. This is reading an external browser value, not
  // deriving state from props, so an effect is the right place for it.
  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash.replace("#", "");
      if (hash && tabs.some((tab) => tab.id === hash)) setActiveId(hash);
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <div>
      <div className="sru-profile-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === active?.id}
            className={`sru-profile-tab${tab.id === active?.id ? " active" : ""}`}
            onClick={() => {
              setActiveId(tab.id);
              window.history.replaceState(null, "", `#${tab.id}`);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="sru-profile-tab-panel" role="tabpanel">
        {active?.content}
      </div>
    </div>
  );
}
