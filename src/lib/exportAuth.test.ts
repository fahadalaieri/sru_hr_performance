import { describe, it, expect } from "vitest";
import { passesExportGate, permissionMapFromRows, type ExportGate } from "./exportAuth";

const rows = [
  { process_area: "competencyFramework", vpra_level: "view" },
  { process_area: "recruitmentBudget", vpra_level: "recommend" },
] as const;

describe("permissionMapFromRows", () => {
  it("indexes the get_my_permissions rows by process area", () => {
    const map = permissionMapFromRows([...rows]);
    expect(map.competencyFramework).toBe("view");
    expect(map.recruitmentBudget).toBe("recommend");
    expect(map.threeSixty).toBeUndefined();
  });

  it("treats a null RPC result as no permissions at all", () => {
    expect(permissionMapFromRows(null)).toEqual({});
  });
});

describe("passesExportGate", () => {
  const permissions = permissionMapFromRows([...rows]);

  it("an empty gate means RLS alone decides, so any authenticated caller passes", () => {
    expect(passesExportGate({}, [])).toBe(true);
  });

  it("passes when the caller meets the single required level", () => {
    const gate: ExportGate = [{ area: "competencyFramework", minLevel: "view" }];
    expect(passesExportGate(permissions, gate)).toBe(true);
  });

  it("fails when the caller holds the area below the required level", () => {
    const gate: ExportGate = [{ area: "competencyFramework", minLevel: "prepare" }];
    expect(passesExportGate(permissions, gate)).toBe(false);
  });

  it("fails when the caller holds no row for the area at all", () => {
    const gate: ExportGate = [{ area: "threeSixty", minLevel: "view" }];
    expect(passesExportGate(permissions, gate)).toBe(false);
  });

  it("a multi-entry gate is an OR: any one satisfied entry is enough", () => {
    const gate: ExportGate = [
      { area: "recruitmentPlan", minLevel: "view" },
      { area: "recruitmentBudget", minLevel: "recommend" },
    ];
    expect(passesExportGate(permissions, gate)).toBe(true);
  });
});
