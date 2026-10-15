/**
 * Placement rules for the staff bulk import
 * (docs/superpowers/specs/2026-10-15-staff-bulk-onboarding-design.md §4-ب, items 2 and 5).
 *
 * Pure: no database, no Excel. The import feeds it the file's rows plus the
 * employee numbers it already knows from `profiles`, and reads back one
 * verdict per row: whether the row is complete enough to be created as
 * approved, whether the person supervises anyone, and whether they head their
 * own org unit (which earns the `manager` role scoped to that unit).
 */
export interface PlacementRow {
  employeeNumber: string;
  orgUnitId: string | null;
  supervisorNumber: string | null;
}

export interface PlacementVerdict {
  /** Org unit resolved AND (supervisor resolved OR this is a root that supervises someone). */
  approved: boolean;
  /** Someone in the file names this number as their supervisor. */
  isSupervisor: boolean;
  /** Own org unit id when this row heads it: supervises someone in its unit while its own supervisor is absent or sits in another unit. */
  headOfOrgUnitId: string | null;
  /** supervisorNumber is set, is not the row itself, and resolves inside `known`. */
  supervisorResolved: boolean;
  /** supervisorNumber === employeeNumber (reported, never written — profiles_supervisor_not_self would refuse it). */
  selfSupervision: boolean;
}

export function placeRows(
  rows: PlacementRow[],
  known: ReadonlyMap<string, { orgUnitId: string | null }>
): Map<string, PlacementVerdict> {
  const byNumber = new Map(rows.map((r) => [r.employeeNumber, r]));

  // Who supervises whom, from this file only. Links already in the database
  // are not re-derived: the import only ever adds what the file says.
  const reports = new Map<string, PlacementRow[]>();
  for (const r of rows) {
    if (!r.supervisorNumber || r.supervisorNumber === r.employeeNumber) continue;
    const list = reports.get(r.supervisorNumber) ?? [];
    list.push(r);
    reports.set(r.supervisorNumber, list);
  }

  const out = new Map<string, PlacementVerdict>();
  for (const r of rows) {
    const selfSupervision = r.supervisorNumber != null && r.supervisorNumber === r.employeeNumber;
    const supervisorResolved = !selfSupervision && r.supervisorNumber != null && known.has(r.supervisorNumber);
    const myReports = reports.get(r.employeeNumber) ?? [];
    const isSupervisor = myReports.length > 0;
    const supervisorUnit = supervisorResolved
      ? (byNumber.get(r.supervisorNumber!)?.orgUnitId ?? known.get(r.supervisorNumber!)?.orgUnitId ?? null)
      : null;
    // Heads their unit when they supervise anyone and their own supervisor is
    // absent or elsewhere: a dean reporting to the president, the president
    // reporting to nobody. A supervisor whose supervisor sits in the same unit
    // is a team lead inside it, not its head.
    const headOfOrgUnitId =
      r.orgUnitId != null && isSupervisor && (!supervisorResolved || supervisorUnit !== r.orgUnitId) ? r.orgUnitId : null;
    const approved = r.orgUnitId != null && (supervisorResolved || (r.supervisorNumber == null && isSupervisor));
    out.set(r.employeeNumber, { approved, isSupervisor, headOfOrgUnitId, supervisorResolved, selfSupervision });
  }
  return out;
}

/**
 * Employee numbers that sit on a supervisor cycle (A→B→A). Empty when the file
 * is a proper tree/forest. A self-loop is not a cycle here: `placeRows` reports
 * it per row as `selfSupervision`, and the import skips just that link.
 */
export function findSupervisorCycles(rows: PlacementRow[]): string[] {
  const next = new Map(rows.map((r) => [r.employeeNumber, r.supervisorNumber === r.employeeNumber ? null : r.supervisorNumber]));
  const onCycle = new Set<string>();
  for (const r of rows) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | null | undefined = r.employeeNumber;
    while (cur && next.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      path.push(cur);
      cur = next.get(cur);
    }
    if (cur && seen.has(cur)) for (const n of path.slice(path.indexOf(cur))) onCycle.add(n);
  }
  return [...onCycle];
}
