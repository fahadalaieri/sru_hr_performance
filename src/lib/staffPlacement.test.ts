import { describe, expect, it } from "vitest";
import { findSupervisorCycles, placeRows, type PlacementRow } from "./staffPlacement";

const U1 = "unit-1";
const U2 = "unit-2";
const rows: PlacementRow[] = [
  { employeeNumber: "100", orgUnitId: U1, supervisorNumber: null }, // president: root, supervises 200
  { employeeNumber: "200", orgUnitId: U2, supervisorNumber: "100" }, // dean of U2: supervisor in another unit, supervises 300
  { employeeNumber: "300", orgUnitId: U2, supervisorNumber: "200" }, // plain employee
  { employeeNumber: "400", orgUnitId: null, supervisorNumber: "200" }, // unmatched unit → pending
  { employeeNumber: "500", orgUnitId: U2, supervisorNumber: "999" }, // unknown supervisor → pending
  { employeeNumber: "600", orgUnitId: U1, supervisorNumber: "600" }, // self-supervision
  { employeeNumber: "700", orgUnitId: U1, supervisorNumber: null }, // no supervisor, supervises nobody → pending
];
const known = new Map(rows.map((r) => [r.employeeNumber, { orgUnitId: r.orgUnitId }]));

describe("placeRows", () => {
  const v = placeRows(rows, known);

  it("root with reports is a head and approved", () => {
    expect(v.get("100")).toMatchObject({ approved: true, isSupervisor: true, headOfOrgUnitId: U1, supervisorResolved: false });
  });

  it("supervisor whose own supervisor sits in another unit heads their unit", () => {
    expect(v.get("200")).toMatchObject({ approved: true, isSupervisor: true, headOfOrgUnitId: U2, supervisorResolved: true });
  });

  it("plain employee is approved and heads nothing", () => {
    expect(v.get("300")).toMatchObject({ approved: true, isSupervisor: false, headOfOrgUnitId: null });
  });

  it("unmatched org unit → pending even with a resolved supervisor", () => {
    expect(v.get("400")!.approved).toBe(false);
    expect(v.get("400")!.supervisorResolved).toBe(true);
  });

  it("unresolved supervisor → pending", () => {
    expect(v.get("500")).toMatchObject({ approved: false, supervisorResolved: false });
  });

  it("self-supervision is reported and not treated as resolved", () => {
    expect(v.get("600")).toMatchObject({ selfSupervision: true, supervisorResolved: false, approved: false });
  });

  it("a leaf without supervisor is pending, not a head", () => {
    expect(v.get("700")).toMatchObject({ approved: false, headOfOrgUnitId: null, isSupervisor: false });
  });

  it("a supervisor known only from the database (not in the file) still resolves", () => {
    const k = new Map(known);
    k.set("999", { orgUnitId: U1 });
    expect(placeRows(rows, k).get("500")!.supervisorResolved).toBe(true);
  });

  it("a supervisor inside the same unit as their own supervisor is not a head", () => {
    const r: PlacementRow[] = [
      { employeeNumber: "1", orgUnitId: U1, supervisorNumber: null },
      { employeeNumber: "2", orgUnitId: U1, supervisorNumber: "1" },
      { employeeNumber: "3", orgUnitId: U1, supervisorNumber: "2" },
    ];
    const k = new Map(r.map((x) => [x.employeeNumber, { orgUnitId: x.orgUnitId }]));
    const out = placeRows(r, k);
    expect(out.get("1")!.headOfOrgUnitId).toBe(U1);
    expect(out.get("2")).toMatchObject({ isSupervisor: true, headOfOrgUnitId: null, approved: true });
  });
});

describe("findSupervisorCycles", () => {
  it("returns the numbers on a cycle and nothing else", () => {
    const cyc: PlacementRow[] = [
      { employeeNumber: "1", orgUnitId: null, supervisorNumber: "2" },
      { employeeNumber: "2", orgUnitId: null, supervisorNumber: "1" },
      { employeeNumber: "3", orgUnitId: null, supervisorNumber: "1" },
    ];
    expect(findSupervisorCycles(cyc).sort()).toEqual(["1", "2"]);
    expect(findSupervisorCycles(rows)).toEqual([]);
  });
});
