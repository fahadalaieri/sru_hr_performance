// Deliberately imports from ./navItems, NOT ./Sidebar — importing Sidebar.tsx
// here would transitively pull in `next-intl/navigation` -> `next/navigation`,
// which fails to resolve under Vitest in this Next.js version (confirmed:
// fails on a bare, non-mocked import, in both "node" and "jsdom"
// environments). See navItems.ts for the full story. Full component
// rendering (Link hrefs, active-class in the DOM) is covered by manual
// browser verification, not by this file.
import { describe, it, expect } from "vitest";
import {
  navItems,
  navGroups,
  navItemHref,
  isNavItemActive,
  isNavGroupActive,
  visibleNavItems,
  visibleNavGroups,
  sidebarGroupLabelKey,
} from "./navItems";

describe("navItems (top-level, ungrouped)", () => {
  it("has exactly 7 items with unique segments", () => {
    // 2026-07-24: promotions/rewards moved under the new "التوصيات"
    // (Recommendations) group tab per the project owner's explicit
    // "بالنسبة للترقيات والمكافآت تكون تحت التوصيات" — no longer flat
    // top-level sidebar entries. 2026-07-25: "reports" joined this list
    // ungated (see below) as a personalized dashboard reachable by everyone.
    // 2026-07-28: "goals/library", "kpis", and "kpis/strategic-goals" moved
    // OUT of this flat list into the new "الخطة الاستراتيجية" group (see
    // navGroups below) per the explicit "اجمعها كلها في موديول واحد" request.
    // 2026-08-04: "vacancies" moved OUT into the new "التوظيف" group, 6 left.
    // 2026-08-28: "competencies" moved back IN from the evaluationMethods
    // group ("ضع موديول الجدارات على السايدبار"), 7 again.
    expect(navItems).toHaveLength(7);
    expect(new Set(navItems.map((i) => i.segment)).size).toBe(7);
  });

  it("has exactly one home item (empty segment)", () => {
    expect(navItems.filter((i) => i.segment === "")).toHaveLength(1);
  });

  it("home and reports are the only ungated items; every other flat item declares an access requirement", () => {
    for (const item of navItems) {
      if (item.segment === "" || item.segment === "reports") {
        expect(item.access).toBeUndefined();
      } else {
        expect(item.access).toBeDefined();
      }
    }
  });
});

describe("navGroups (2026-07-24 grouped nav)", () => {
  it("has exactly 7 groups, with threeSixty added after recruitment (2026-09-02)", () => {
    expect(navGroups.map((g) => g.groupKey)).toEqual([
      "strategicPlan",
      "executivePlan",
      "administration",
      "evaluationMethods",
      "recruitment",
      "threeSixty",
      "evaluationResults",
    ]);
  });

  // "التقييم الدائري" (360 Review, 2026-09-02): two HR tabs gated on the new
  // `threeSixty` area, and five self-service tabs deliberately ungated --
  // same "kpis"/"reports" precedent (real access is row-level: self,
  // is_my_direct_report, is_my_subordinate — not a role_permissions grant
  // most roles never hold).
  it("the threeSixty group has its two gated tabs and five ungated self-service tabs", () => {
    const threeSixty = navGroups.find((g) => g.groupKey === "threeSixty")!;
    expect(threeSixty.children.map((c) => c.segment)).toEqual([
      "three-sixty",
      "three-sixty/template",
      "three-sixty/nominate",
      "three-sixty/approvals",
      "three-sixty/rate",
      "three-sixty/report",
      "three-sixty/team-report",
    ]);
    expect(threeSixty.children[0].access).toEqual([{ processArea: "threeSixty", minLevel: "view" }]);
    expect(threeSixty.children[1].access).toEqual([{ processArea: "threeSixty", minLevel: "prepare" }]);
    for (const child of threeSixty.children.slice(2)) {
      expect(child.access).toBeUndefined();
    }
  });

  // 2026-08-04: the "التوظيف" module — خطة التوظيف (its own new
  // `recruitmentPlan` area) + الترقيات + الشواغر (both reusing the areas
  // that already gate their real tables' RLS).
  // 2026-08-04: a fourth tab, "الوظائف المعلن عنها", was added — fed from
  // the الشواغر tab's own advertise action, so it shares the `vacancies`
  // grant rather than introducing a process area of its own.
  // 2026-08-05: a fifth tab, "بوابة التوظيف" — the outward-facing list of ads
  // whose publication window is currently open. Also `vacancies`-gated.
  // 2026-08-07: a sixth tab, "طلبات الاحتياج" — the demand side of the plan.
  // 2026-08-07: طلب الاحتياج والبوابة صار لكلٍّ منهما مجاله الخاص، والبوابة
  // انقسمت إلى داخلية وخارجية — سبعة تبويبات الآن.
  it("the recruitment group has the seven tabs, each gated on its own area", () => {
    const recruitment = navGroups.find((g) => g.groupKey === "recruitment")!;
    expect(recruitment.children.map((c) => c.segment)).toEqual([
      "recruitment/plan",
      "recruitment/requests",
      "promotions",
      "vacancies",
      "recruitment/announced",
      "recruitment/portal",
      "recruitment/portal/external",
    ]);
    expect(recruitment.children.map((c) => c.access?.[0].processArea)).toEqual([
      "recruitmentPlan",
      "recruitmentRequests",
      "promotions",
      "vacancies",
      "vacancies",
      "recruitmentPortal",
      "recruitmentPortal",
    ]);
  });

  // The requests tab is the only child in this group with TWO access entries.
  // `visibleNavItems` ORs them, which is what lets a finance reviewer holding
  // `recruitmentBudget` alone — and no `recruitmentPlan` grant whatsoever —
  // reach the requests they must review. It mirrors `recruitment_requests`'
  // own SELECT policy rather than restating a narrower rule in the UI.
  it("reaches the requests tab through recruitmentBudget alone", () => {
    const recruitment = navGroups.find((g) => g.groupKey === "recruitment")!;
    const requests = recruitment.children.find((c) => c.segment === "recruitment/requests")!;
    expect(requests.access).toEqual([
      { processArea: "recruitmentRequests", minLevel: "view" },
      { processArea: "recruitmentBudget", minLevel: "view" },
    ]);

    const financeOnly = visibleNavItems(recruitment.children, { recruitmentBudget: "recommend" });
    expect(financeOnly.map((c) => c.segment)).toEqual(["recruitment/requests"]);

    // A coordinator granted ONLY the requests area reaches the requests tab
    // and nothing else — which is exactly what splitting it out achieves: the
    // plan tab now needs its own `recruitmentPlan` grant.
    const coordinator = visibleNavItems(recruitment.children, { recruitmentRequests: "prepare" });
    expect(coordinator.map((c) => c.segment)).toEqual(["recruitment/requests"]);

    const planOnly = visibleNavItems(recruitment.children, { recruitmentPlan: "prepare" });
    expect(planOnly.map((c) => c.segment)).toEqual(["recruitment/plan"]);

    expect(visibleNavItems(recruitment.children, {})).toEqual([]);
  });

  it("every child in every group declares an access requirement, except the deliberately ungated self-service tabs", () => {
    // Two deliberate exceptions across all groups:
    //   "kpis" (الأهداف المسندة) — real access is entirely row-level via the
    //     strategic-goal cascade's own RLS, not a role_permissions grant.
    //   "kpis/plans" (قائمة الخطط) — ungated on 2026-08-01: browsing which
    //     plans exist and opening one is for all staff; only creating a new
    //     plan stays gated at 'approve' on the page itself.
    // "kpis/strategic-identity", "kpis/strategic-goals", and "goals/library"
    // were removed from this group entirely on 2026-08-01 -- each now lives
    // only as a tab inside the per-plan detail page (/kpis/plans/[id]),
    // which has no static NavItem segment to gate here; their standalone
    // routes are still reachable directly, just not from this tab bar.
    // 2026-08-20: "operational-plans" joins them, for the same reason as
    // "kpis/plans" -- browsing which plans exist is for all staff, and
    // creating one is gated on the page itself. "kpis" moved into the new
    // executivePlan group but stays ungated for the same row-level reason.
    const ungated = new Set([
      "kpis/plans",
      "operational-plans",
      "initiative-assignments",
      // "التقييم الدائري" self-service tabs (2026-09-02) -- see the dedicated
      // threeSixty test above for why these five are deliberately ungated.
      "three-sixty/nominate",
      "three-sixty/approvals",
      "three-sixty/rate",
      "three-sixty/report",
      "three-sixty/team-report",
      // "نتائج التقييم" (2026-09-07) -- see the dedicated evaluationResults
      // test above for why these two are deliberately ungated.
      "evaluation-results",
      "evaluation-results/employees",
    ]);
    for (const group of navGroups) {
      for (const child of group.children) {
        if (ungated.has(child.segment)) {
          expect(child.access).toBeUndefined();
        } else {
          expect(child.access).toBeDefined();
        }
      }
    }
  });

  it("the strategicPlan group is now the plans list alone, and executivePlan owns الأهداف المسندة (2026-08-20)", () => {
    // Per direct feedback: the plans-list page's own tab bar should not show
    // the vision/mission, strategic-goals, or goal-library tabs anymore --
    // "لأن لكل لها عناوينها الخاص بها" (each already has its own header,
    // now inside the per-plan detail page) -- only "قائمة الخطط" and
    // "الأهداف المسندة" remain as top-level tabs for this group.
    const plan = navGroups.find((g) => g.groupKey === "strategicPlan")!;
    expect(plan.children.map((c) => c.segment)).toEqual(["kpis/plans"]);

    // "تنقل تاب الاهداف المسندة وبنك الاهداف الى موديول جديد بمسمى الخطة
    // التنفيذية" — the move, asserted from the other side too.
    const executive = navGroups.find((g) => g.groupKey === "executivePlan")!;
    expect(executive.children.map((c) => c.segment)).toEqual(["operational-plans", "initiative-assignments"]);
  });

  it("no segment is duplicated across navItems and all group children combined", () => {
    const allSegments = [...navItems.map((i) => i.segment), ...navGroups.flatMap((g) => g.children.map((c) => c.segment))];
    expect(new Set(allSegments).size).toBe(allSegments.length);
  });

  it("the administration group has its seven children (reports moved out 2026-07-25, user-activity added 2026-07-25, settings added 2026-07-26, org-units added 2026-08-29)", () => {
    const admin = navGroups.find((g) => g.groupKey === "administration")!;
    expect(admin.children.map((c) => c.segment)).toEqual([
      "admin/org-structure",
      "org-units",
      "admin/org-structure/staffing",
      "admin",
      "admin/identity",
      "admin/user-activity",
      "admin/settings",
    ]);
  });

  it("the evaluationMethods group has two children (competencies moved to the top-level sidebar 2026-08-28, feedback-360 retired 2026-09-05)", () => {
    const methods = navGroups.find((g) => g.groupKey === "evaluationMethods")!;
    expect(methods.children.map((c) => c.segment)).toEqual(["evaluations", "bau-tasks"]);
  });

  // "نتائج التقييم" (2026-09-07): dashboard + employee-results tabs added
  // ahead of the existing recommendations tab, both deliberately ungated —
  // same self-service precedent as threeSixty's own tabs (see that group's
  // test above).
  it("the evaluationResults group has the dashboard/employee-results tabs before recommendations", () => {
    const results = navGroups.find((g) => g.groupKey === "evaluationResults")!;
    expect(results.children.map((c) => c.segment)).toEqual([
      "evaluation-results",
      "evaluation-results/employees",
      "recommendations",
    ]);
    expect(results.children[0].access).toBeUndefined();
    expect(results.children[1].access).toBeUndefined();
    expect(results.children[2].access).toEqual([{ processArea: "rewardsAndRecommendations", minLevel: "view" }]);
  });
});

describe("visibleNavItems", () => {
  it("always shows home, even with zero permissions", () => {
    const visible = visibleNavItems(navItems, {});
    expect(visible.map((i) => i.segment)).toContain("");
  });

  it("hides admin/reference tabs for the real employee permission set", () => {
    // The actual seeded `employee` role grants (2026-07-22): goalsLibrary=view,
    // competencyFramework=view, goalAssignment=view, bauTasks=prepare,
    // evaluation=prepare, vacancies=view, careerPath=view — no
    // strategicPlanning grant at all (2026-07-27: that area is
    // strategy_admin/ceo only, everyone else's cascade access is row-level,
    // not a role grant) — everything else (employeeData, calibration,
    // promotions, userManagement, orgStructure) is absent (none).
    const employeePermissions = {
      competencyFramework: "view",
      bauTasks: "prepare",
      evaluation: "prepare",
      vacancies: "view",
      careerPath: "view",
    } as const;

    const segments = visibleNavItems(navItems, employeePermissions).map((i) => i.segment);

    // Explicitly reported as tabs that should NOT show for a plain employee.
    expect(segments).not.toContain("employees");
    expect(segments).not.toContain("salary-scale");
    expect(segments).not.toContain("calibration");

    // Still meaningful for a plain employee.
    expect(segments).toContain("");
    expect(segments).toContain("career-path");
    // "vacancies" moved into the recruitment group (2026-08-04) -- an
    // employee's real `vacancies=view` grant still surfaces it there, asserted
    // in the visibleNavGroups tests below rather than here.
    expect(segments).not.toContain("vacancies");
    // Ungated (2026-07-25): reports is a personalized dashboard reachable by everyone.
    expect(segments).toContain("reports");
    // "competencies" moved back to the top-level sidebar (2026-08-28) -- an
    // employee's real `competencyFramework=view` grant surfaces it here now,
    // not inside a group.
    expect(segments).toContain("competencies");

    // goals/library, kpis, and kpis/strategic-goals moved into the
    // strategicPlan group (2026-07-28) -- see the visibleNavGroups tests
    // below for their per-child visibility.
  });

  it("shows every tab for a full-access permission set", () => {
    const allApprove = Object.fromEntries(
      navItems.filter((i) => i.access).flatMap((i) => i.access!.map((a) => [a.processArea, "approve"]))
    );
    const segments = visibleNavItems(navItems, allApprove).map((i) => i.segment);
    expect(segments).toHaveLength(navItems.length);
  });

  it("employees is visible with only the narrower employeeDataSubordinates grant, when the caller genuinely has subordinates", () => {
    // Real report (2026-07-27): a manager/deputy with genuine direct reports
    // but no employeeData grant -- only employeeDataSubordinates -- could
    // already see their team on the /employees page itself via RLS, but the
    // sidebar tab never showed at all.
    const segments = visibleNavItems(navItems, { employeeDataSubordinates: "view" }, { hasSubordinates: true }).map(
      (i) => i.segment
    );
    expect(segments).toContain("employees");
  });

  it("employees stays hidden via employeeDataSubordinates alone when the caller has zero real subordinates", () => {
    // Follow-up request (2026-08-30): qualifying only through the
    // subordinates branch with no actual reports would just open to nothing
    // useful, so it's excluded even though the VPRA grant itself is met.
    const withoutContext = visibleNavItems(navItems, { employeeDataSubordinates: "view" }).map((i) => i.segment);
    expect(withoutContext).not.toContain("employees");

    const withFalseContext = visibleNavItems(
      navItems,
      { employeeDataSubordinates: "view" },
      { hasSubordinates: false }
    ).map((i) => i.segment);
    expect(withFalseContext).not.toContain("employees");
  });

  it("employees stays visible via employeeData regardless of hasSubordinates", () => {
    const segments = visibleNavItems(navItems, { employeeData: "view" }, { hasSubordinates: false }).map(
      (i) => i.segment
    );
    expect(segments).toContain("employees");
  });
});

describe("visibleNavGroups", () => {
  it("always shows both plan groups plus threeSixty's and evaluationResults' ungated tabs regardless of permissions", () => {
    // 2026-08-01: after removing the vision/mission, strategic-goals, and
    // goal-library tabs from this group, its only two remaining children
    // ("kpis/plans", "kpis") are both ungated -- so this group's visibility
    // no longer varies by permission at all, unlike before.
    // 2026-09-02: threeSixty joins them -- five of its seven tabs are
    // ungated self-service pages, so the group (with just those five
    // children) is always visible too, even with zero grants.
    // 2026-09-07: evaluationResults joins them too -- its dashboard/
    // employee-results tabs are both ungated (recommendations stays gated).
    const groups = visibleNavGroups(navGroups, {});
    expect(groups.map((g) => g.groupKey)).toEqual(["strategicPlan", "executivePlan", "threeSixty", "evaluationResults"]);
    expect(groups[0].children.map((c) => c.segment)).toEqual(["kpis/plans"]);
    expect(groups[1].children.map((c) => c.segment)).toEqual(["operational-plans", "initiative-assignments"]);
    expect(groups[2].children.map((c) => c.segment)).toEqual([
      "three-sixty/nominate",
      "three-sixty/approvals",
      "three-sixty/rate",
      "three-sixty/report",
      "three-sixty/team-report",
    ]);
    expect(groups[3].children.map((c) => c.segment)).toEqual(["evaluation-results", "evaluation-results/employees"]);
  });

  it("still shows both plan groups for a strategy_admin-level permission set", () => {
    const groups = visibleNavGroups(navGroups, { strategicPlanning: "approve" });
    expect(groups.find((g) => g.groupKey === "strategicPlan")!.children.map((c) => c.segment)).toEqual(["kpis/plans"]);
    expect(groups.find((g) => g.groupKey === "executivePlan")!.children.map((c) => c.segment)).toEqual([
      "operational-plans",
      "initiative-assignments",
    ]);
  });

  it("hides only the ungranted children within an otherwise-visible group (employee perms)", () => {
    const employeePermissions = {
      bauTasks: "prepare",
      evaluation: "prepare",
      competencyFramework: "view",
    } as const;
    const groups = visibleNavGroups(navGroups, employeePermissions);
    const methods = groups.find((g) => g.groupKey === "evaluationMethods");
    expect(methods).toBeDefined();
    const segments = methods!.children.map((c) => c.segment);
    // evaluation=prepare clears "evaluations" (view); feedback-360 was retired 2026-09-05.
    expect(segments).toContain("evaluations");
    expect(segments).toContain("bau-tasks");
    // "competencies" moved out of this group entirely (2026-08-28) -- its
    // own competencyFramework=view grant is asserted at the top level instead.
    expect(segments).not.toContain("competencies");

    // administration group: no orgStructure/userManagement grant at all -> fully hidden.
    expect(groups.find((g) => g.groupKey === "administration")).toBeUndefined();
  });

  // 2026-08-04: a plain employee genuinely holds `vacancies=view` (internal
  // job postings are documented as visible to all staff) but no promotions or
  // recruitmentPlan grant -- so the التوظيف group appears with only the two
  // vacancy-gated tabs (الشواغر and, since 2026-08-04, الوظائف المعلن عنها,
  // which is fed from it and gated on the same grant).
  it("shows the recruitment group's vacancy tabs for the real employee permission set", () => {
    // 2026-08-07: the portal moved to its own `recruitmentPortal` area and
    // split into internal/external, so a `vacancies`-only grant no longer
    // reaches it — that is the point of the split.
    const groups = visibleNavGroups(navGroups, { vacancies: "view", recruitmentPortal: "view" });
    const recruitment = groups.find((g) => g.groupKey === "recruitment");
    expect(recruitment).toBeDefined();
    expect(recruitment!.children.map((c) => c.segment)).toEqual([
      "vacancies",
      "recruitment/announced",
      "recruitment/portal",
      "recruitment/portal/external",
    ]);
    // More than one visible child -> the sidebar row keeps the group label.
    expect(sidebarGroupLabelKey(recruitment!)).toBe("recruitment");
  });

  it("hides the recruitment group entirely with none of its three grants", () => {
    const groups = visibleNavGroups(navGroups, { evaluation: "prepare" });
    expect(groups.find((g) => g.groupKey === "recruitment")).toBeUndefined();
  });

  it("shows every group and every child for a full-access permission set", () => {
    const allApprove = Object.fromEntries(
      navGroups
        .flatMap((g) => g.children)
        .filter((c) => c.access)
        .flatMap((c) => c.access!.map((a) => [a.processArea, "approve"]))
    );
    const groups = visibleNavGroups(navGroups, allApprove);
    expect(groups).toHaveLength(navGroups.length);
    const totalChildren = groups.reduce((sum, g) => sum + g.children.length, 0);
    const expectedTotal = navGroups.reduce((sum, g) => sum + g.children.length, 0);
    expect(totalChildren).toBe(expectedTotal);
  });
});

describe("sidebarGroupLabelKey", () => {
  it("uses the child's own label when exactly one child is visible (e.g. orgStructure=view only)", () => {
    // Real feedback (2026-07-25): a caller with only orgStructure=view sees
    // just الهيكل التنظيمي's chart-only view (staffing/identity/admin are
    // now separate process areas) -- the sidebar's "الإدارة" group label
    // should read as "الهيكل التنظيمي" specifically in that case, not the
    // generic group name, since that's the only thing actually behind it.
    const groups = visibleNavGroups(navGroups, { orgStructure: "view" });
    const administration = groups.find((g) => g.groupKey === "administration")!;
    expect(administration.children).toHaveLength(1);
    expect(administration.children[0].segment).toBe("admin/org-structure");
    expect(sidebarGroupLabelKey(administration)).toBe("orgStructure");
  });

  it("uses the generic group label when more than one child is visible", () => {
    const groups = visibleNavGroups(navGroups, { orgStructure: "recommend", staffing: "view" });
    const administration = groups.find((g) => g.groupKey === "administration")!;
    expect(administration.children.length).toBeGreaterThan(1);
    expect(sidebarGroupLabelKey(administration)).toBe("administration");
  });
});

describe("navItemHref", () => {
  it("returns '/' for the home item", () => {
    expect(navItemHref("")).toBe("/");
  });

  it("returns '/<segment>' for every other item, including multi-segment ones", () => {
    expect(navItemHref("employees")).toBe("/employees");
    expect(navItemHref("admin/org-structure")).toBe("/admin/org-structure");
  });
});

describe("isNavItemActive", () => {
  it("home is active only on the exact root, never on a sub-path", () => {
    expect(isNavItemActive("", "/")).toBe(true);
    expect(isNavItemActive("", "/competencies")).toBe(false);
    expect(isNavItemActive("", "/admin")).toBe(false);
  });

  it("a non-home item is active on its own exact path", () => {
    expect(isNavItemActive("competencies", "/competencies")).toBe(true);
    expect(isNavItemActive("admin", "/admin")).toBe(true);
  });

  it("a leaf item with no more-specific sibling stays active on nested sub-paths", () => {
    expect(isNavItemActive("evaluations", "/evaluations/123")).toBe(true);
  });

  it("a non-home item is not active on an unrelated path", () => {
    expect(isNavItemActive("competencies", "/admin")).toBe(false);
    expect(isNavItemActive("admin", "/")).toBe(false);
  });

  // The real bug this fix targets: "admin" and "admin/org-structure" share a
  // URL prefix but are now separate sibling nav entries (الصلاحيات vs
  // الهيكل التنظيمي), not a page-and-sub-route pair.
  it("longest-prefix-wins disambiguates sibling entries sharing a URL prefix", () => {
    expect(isNavItemActive("admin", "/admin/org-structure")).toBe(false);
    expect(isNavItemActive("admin/org-structure", "/admin/org-structure")).toBe(true);

    expect(isNavItemActive("admin/org-structure", "/admin/org-structure/staffing")).toBe(false);
    expect(isNavItemActive("admin/org-structure/staffing", "/admin/org-structure/staffing")).toBe(true);

    expect(isNavItemActive("admin", "/admin/identity")).toBe(false);
    expect(isNavItemActive("admin/identity", "/admin/identity")).toBe(true);

    // The exact base page is still correctly active for itself.
    expect(isNavItemActive("admin", "/admin")).toBe(true);
  });

  it("no two known segments are simultaneously active for any real route in the table", () => {
    const allSegments = [...navItems.map((i) => i.segment), ...navGroups.flatMap((g) => g.children.map((c) => c.segment))];
    for (const current of allSegments) {
      const pathname = navItemHref(current);
      const activeSegments = allSegments.filter((segment) => isNavItemActive(segment, pathname));
      expect(activeSegments).toEqual([current]);
    }
  });
});

describe("isNavGroupActive", () => {
  it("a group is active when the pathname matches any of its children", () => {
    const admin = navGroups.find((g) => g.groupKey === "administration")!;
    expect(isNavGroupActive(admin, "/admin/org-structure")).toBe(true);
    expect(isNavGroupActive(admin, "/admin/identity")).toBe(true);
    expect(isNavGroupActive(admin, "/employees")).toBe(false);
  });
});
