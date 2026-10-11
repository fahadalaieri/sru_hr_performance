import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const env = {
  get url() { return required("NEXT_PUBLIC_SUPABASE_URL"); },
  get anonKey() { return required("NEXT_PUBLIC_SUPABASE_ANON_KEY"); },
  get serviceKey() { return required("SUPABASE_SERVICE_ROLE_KEY"); },
  get databaseUrl() { return required("DATABASE_URL"); },
  get baseUrl() { return process.env.INTEGRATION_BASE_URL ?? null; },
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — integration tests need a development .env.local`);
  return v;
}

export const hasDatabase = Boolean(process.env.DATABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);

const noSession = { auth: { autoRefreshToken: false, persistSession: false } };
export const adminClient = (): SupabaseClient => createClient(env.url, env.serviceKey, noSession);
export const anonClient = (): SupabaseClient => createClient(env.url, env.anonKey, noSession);

export async function pgClient(): Promise<Client> {
  const c = new Client({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

/**
 * Inside an open transaction: run the rest of it as `authenticated` with the
 * given auth user id, exactly the way RLS sees a real request (auth.uid() reads
 * request.jwt.claims.sub). Pair with `asService()` to switch back.
 */
export async function asUser(c: Client, authUserId: string): Promise<void> {
  await c.query("SET LOCAL ROLE authenticated");
  await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: authUserId, role: "authenticated" })]);
}
export async function asService(c: Client): Promise<void> {
  await c.query("RESET ROLE");
}

export interface TempUser { profileId: string; authUserId: string; email: string; password: string }

/**
 * A committed profile + real auth user (so `link_profile_to_auth_user()` links
 * them and auth.uid() resolves). Emails are lower-cased: Supabase normalises
 * them, and a mixed-case fixture email silently fails to link (a lesson from
 * 2026-10-07). Always delete through `Fixtures.cleanup()`.
 */
export class Fixtures {
  readonly tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  private profiles: string[] = [];
  private users: string[] = [];
  constructor(private readonly admin: SupabaseClient) {}

  async user(key: string, profile: Record<string, unknown> = {}): Promise<TempUser> {
    const email = `tmp-it-${key}-${this.tag}@sru-dev.internal`.toLowerCase();
    const password = `Tmp-${this.tag}-Pw!x`;
    const { data: p, error } = await this.admin
      .from("profiles")
      .insert({ employee_number: `TMPIT-${key}-${this.tag}`, full_name_ar: `اختبار تكامل ${key}`, email, status: "active", approval_status: "approved", ...profile })
      .select("id")
      .single();
    if (error) throw error;
    this.profiles.push(p.id);
    const { data: u, error: e2 } = await this.admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (e2) throw e2;
    this.users.push(u.user.id);
    const { data: linked } = await this.admin.from("profiles").select("auth_user_id").eq("id", p.id).single();
    if (linked?.auth_user_id !== u.user.id) throw new Error(`fixture ${key} did not link to its auth user`);
    return { profileId: p.id, authUserId: u.user.id, email, password };
  }

  async roleId(code: string): Promise<string> {
    const { data, error } = await this.admin.from("roles").select("id").eq("role_code", code).single();
    if (error) throw error;
    return data.id;
  }

  async cleanup(): Promise<void> {
    for (const uid of this.users) await this.admin.auth.admin.deleteUser(uid);
    if (this.profiles.length) await this.admin.from("profiles").delete().in("id", this.profiles);
    this.users = [];
    this.profiles = [];
  }
}

/** The cookie `@supabase/ssr` itself would store for this session, so Route Handlers see a real login. */
export function sessionCookie(session: { access_token: string; refresh_token: string }, extra: Record<string, unknown> = {}): string {
  const ref = new URL(env.url).hostname.split(".")[0];
  const value = "base64-" + Buffer.from(JSON.stringify({ ...session, ...extra })).toString("base64url");
  const name = `sb-${ref}-auth-token`;
  if (value.length <= 3180) return `${name}=${value}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < value.length; i += 3180, n++) parts.push(`${name}.${n}=${value.slice(i, i + 3180)}`);
  return parts.join("; ");
}
