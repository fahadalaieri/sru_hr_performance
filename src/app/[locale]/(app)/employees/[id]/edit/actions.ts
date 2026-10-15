"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const editSchema = z.object({
  profileId: z.string().uuid(),
  // Editable since 2026-10-15 so the SSO placeholder ("SSO-…") can be replaced
  // by the real HR number on approval; UNIQUE on the column → "duplicate".
  employeeNumber: z.string().trim().min(1).max(32),
  fullNameAr: z.string().trim().min(1),
  fullNameEn: z.string().trim().optional(),
  // Optional since 2026-07-25 (profiles.email dropped its NOT NULL) —
  // "اجعل البريد الالكتروني اختياريا وليس اجباريا".
  email: z.string().trim().toLowerCase().email().optional(),
  username: z.string().trim().regex(/^[a-zA-Z0-9_.]{3,32}$/).optional(),
  orgUnitId: z.string().uuid(),
  jobTitleId: z.string().uuid().optional(),
  hireDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  status: z.enum(["active", "on_leave", "terminated"]),
  qualification: z.string().trim().optional(),
  certificates: z.string().trim().optional(),
  educationSpeciality: z.string().trim().optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  mobile: z.string().trim().optional(),
  maritalStatus: z.string().trim().optional(),
  gender: z.string().trim().optional(),
  nationality: z.string().trim().optional(),
  employeeCategory: z.string().trim().optional(),
  insuranceCategory: z.string().trim().optional(),
});

export type EditEmployeeState =
  | { status: "success" }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "forbidden" | "duplicate" | "unknown" }
  | null;

/**
 * Updates a `profiles` row (2026-07-24, part of the View/Edit/Delete row
 * actions request). Deliberately scoped to `profiles`' own columns only —
 * role assignment is a distinct, already-existing concern
 * (invite/pending_role_assignments, assign-supervisor) not touched here.
 * The UPDATE goes through the caller's own RLS-respecting client — real
 * authorization is `profiles_update`'s own `check_vpra('employeeData',
 * 'prepare', org_unit_id)`, not this action's code; the UI only shows the
 * Edit button at the higher `'approve'` bar (see EmployeeDetailPage /
 * EmployeesPage), matching the project owner's explicit "for super_admin
 * and hr_admin" ask, without hardcoding those role names anywhere.
 */
export async function updateEmployee(_prevState: EditEmployeeState, formData: FormData): Promise<EditEmployeeState> {
  const parsed = editSchema.safeParse({
    profileId: formData.get("profileId"),
    employeeNumber: formData.get("employeeNumber"),
    fullNameAr: formData.get("fullNameAr"),
    fullNameEn: formData.get("fullNameEn") || undefined,
    email: formData.get("email") || undefined,
    username: formData.get("username") || undefined,
    orgUnitId: formData.get("orgUnitId"),
    jobTitleId: formData.get("jobTitleId") || undefined,
    hireDate: formData.get("hireDate") || undefined,
    status: formData.get("status"),
    qualification: formData.get("qualification") || undefined,
    certificates: formData.get("certificates") || undefined,
    educationSpeciality: formData.get("educationSpeciality") || undefined,
    dateOfBirth: formData.get("dateOfBirth") || undefined,
    mobile: formData.get("mobile") || undefined,
    maritalStatus: formData.get("maritalStatus") || undefined,
    gender: formData.get("gender") || undefined,
    nationality: formData.get("nationality") || undefined,
    employeeCategory: formData.get("employeeCategory") || undefined,
    insuranceCategory: formData.get("insuranceCategory") || undefined,
  });

  if (!parsed.success) {
    return { status: "error", message: "invalid_input" };
  }

  const supabase = await createClient();
  const {
    data: { user: actor },
  } = await supabase.auth.getUser();
  if (!actor) {
    return { status: "error", message: "unauthenticated" };
  }

  const { profileId, ...fields } = parsed.data;

  const { data: before } = await supabase.from("profiles").select("*").eq("id", profileId).maybeSingle();

  const { error, count } = await supabase
    .from("profiles")
    .update(
      {
        employee_number: fields.employeeNumber,
        full_name_ar: fields.fullNameAr,
        full_name_en: fields.fullNameEn ?? null,
        email: fields.email ?? null,
        username: fields.username ?? null,
        org_unit_id: fields.orgUnitId,
        job_title_id: fields.jobTitleId ?? null,
        hire_date: fields.hireDate ?? null,
        status: fields.status,
        qualification: fields.qualification ?? null,
        certificates: fields.certificates ?? null,
        education_speciality: fields.educationSpeciality ?? null,
        date_of_birth: fields.dateOfBirth ?? null,
        mobile: fields.mobile ?? null,
        marital_status: fields.maritalStatus ?? null,
        gender: fields.gender ?? null,
        nationality: fields.nationality ?? null,
        employee_category: fields.employeeCategory ?? null,
        insurance_category: fields.insuranceCategory ?? null,
      },
      { count: "exact" }
    )
    .eq("id", profileId)
    .is("deleted_at", null);

  if (error) {
    if (error.code === "23505") return { status: "error", message: "duplicate" };
    return { status: "error", message: "unknown" };
  }
  if (!count) {
    return { status: "error", message: "forbidden" };
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "employee_updated",
    entity: "profiles",
    entity_id: profileId,
    before_data: before,
    after_data: fields,
  });

  return { status: "success" };
}

const setPasswordSchema = z.object({
  profileId: z.string().uuid(),
  // Same floor the self-service form enforces, so an admin-set password can
  // never be weaker than one the employee could choose for themselves.
  password: z.string().min(8).max(72),
});

export type SetPasswordState =
  | { status: "success" }
  | {
      status: "error";
      message: "invalid_input" | "unauthenticated" | "forbidden" | "no_account" | "unknown";
    }
  | null;

/**
 * Sets an employee's password directly — «أضف خاصية تغيير الرقم السري وكذلك
 * أضفها عند الأدمن».
 *
 * This is the answer to a real, standing problem: the accounts created
 * without a mailbox (`@no-email.internal`) can never use "نسيت كلمة المرور",
 * because there is nowhere to send the link. Without this, an employee who
 * forgets their password has no route back in at all.
 *
 * THREE THINGS THIS DELIBERATELY DOES:
 *
 * 1. Re-checks `userManagement>=approve` HERE, not just in the page that
 *    renders the field. Everything else on this screen is gated by RLS on
 *    `profiles`, but a password lives in `auth.users`, which is reached
 *    through the service-role client — RLS does not apply to it at all, so
 *    this check IS the boundary. Nothing else stands behind it.
 *
 * 2. Forces `must_change_password`, so an administrator never keeps a working
 *    password to somebody else's account: the employee is made to replace it
 *    the moment they sign in, by the same mechanism the direct-create flow
 *    already uses (20260725000007).
 *
 * 3. Records the act, never the secret. `audit_log` says who reset whose
 *    password and when — a password reset by an administrator is exactly the
 *    kind of act CLAUDE.md §5 wants a trail for — and the password itself
 *    appears in no column and no log line.
 */
export async function setEmployeePassword(input: {
  profileId: string;
  password: string;
}): Promise<SetPasswordState> {
  const parsed = setPasswordSchema.safeParse(input);
  if (!parsed.success) return { status: "error", message: "invalid_input" };

  const supabase = await createClient();
  const {
    data: { user: actor },
  } = await supabase.auth.getUser();
  if (!actor) return { status: "error", message: "unauthenticated" };

  const { data: allowed } = await supabase.rpc("check_vpra", {
    p_process_area: "userManagement",
    p_min_level: "approve",
  });
  if (!allowed) return { status: "error", message: "forbidden" };

  // Read through the CALLER's client: an admin who cannot see this profile
  // under `profiles_select` has no business setting its password either.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, auth_user_id, employee_number")
    .eq("id", parsed.data.profileId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!profile) return { status: "error", message: "forbidden" };
  // An invited employee who has not accepted yet has no auth account to set a
  // password on — say so plainly instead of failing with something opaque.
  if (!profile.auth_user_id) return { status: "error", message: "no_account" };

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(profile.auth_user_id, {
    password: parsed.data.password,
  });
  if (error) return { status: "error", message: "unknown" };

  await admin.from("profiles").update({ must_change_password: true }).eq("id", profile.id);

  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "employee_password_set",
    entity: "profiles",
    entity_id: profile.id,
    before_data: null,
    // The employee number identifies WHOSE password was reset without
    // repeating anything sensitive. The password is not recorded anywhere.
    after_data: { employee_number: profile.employee_number, must_change_password: true },
  });

  return { status: "success" };
}
