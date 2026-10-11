import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasVpraAccess, type ProcessArea, type VpraLevel } from "@/lib/vpra";

export type PermissionMap = Partial<Record<ProcessArea, VpraLevel>>;

/**
 * One requirement a caller may satisfy. A gate is an OR-list of these: the
 * caller passes if ANY entry holds. An EMPTY gate means "RLS alone decides"
 * -- the screen this export mirrors has no permission check of its own
 * beyond login, so the file contains exactly the rows that screen shows.
 */
export type ExportGate = ReadonlyArray<{ area: ProcessArea; minLevel: VpraLevel }>;

export function permissionMapFromRows(rows: ReadonlyArray<{ process_area: string; vpra_level: string }> | null | undefined): PermissionMap {
  const map: PermissionMap = {};
  for (const row of rows ?? []) map[row.process_area as ProcessArea] = row.vpra_level as VpraLevel;
  return map;
}

export function passesExportGate(permissions: PermissionMap, gate: ExportGate): boolean {
  if (gate.length === 0) return true;
  return gate.some(({ area, minLevel }) => hasVpraAccess(permissions[area] ?? "none", minLevel));
}

/**
 * The one permission check every export Route Handler runs (2026-10-07).
 *
 * Product rule, decided once here rather than per route: EXPORTING A TABLE
 * REQUIRES EXACTLY THE PERMISSION THAT SHOWS IT ON SCREEN -- no more, no
 * less. Each route declares the gate its page uses; a page with no gate of
 * its own declares an empty gate explicitly, so "RLS only" is a visible
 * decision in the route file, not an omission. Before this, 3 of 11 routes
 * had hand-rolled checks and 8 had none, which is the drift a 2026-10-05
 * review flagged.
 *
 * RLS stays the real boundary (a caller RLS excludes gets zero rows); this
 * answers with a clear 401/403 instead of an empty spreadsheet, and makes
 * every route's authorization readable in one line.
 */
export async function requireExportAccess(
  supabase: SupabaseClient,
  gate: ExportGate
): Promise<{ ok: true; userId: string; permissions: PermissionMap } | { ok: false; response: NextResponse }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };

  // Always fetched: routes with a custom rule (evaluation results) read it too.
  const { data: permissionRows } = await supabase.rpc("get_my_permissions");
  const permissions = permissionMapFromRows(permissionRows as { process_area: string; vpra_level: string }[] | null);
  if (!passesExportGate(permissions, gate)) {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true, userId: user.id, permissions };
}
