import { z } from "zod";

/**
 * Input of `reviewEmployeeApproval` (2026-10-15: approval can place the
 * employee in the same step — org unit, official title, supervisor). Lives
 * outside the "use server" file so it can be unit-tested; Next only allows
 * async exports from a server-action module.
 */
const optionalUuid = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.string().uuid().optional());

export const reviewApprovalSchema = z
  .object({
    profileId: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    orgUnitId: optionalUuid,
    jobTitleId: optionalUuid,
    supervisorId: optionalUuid,
  })
  .refine((d) => d.supervisorId !== d.profileId, { path: ["supervisorId"], message: "self" });

export type ReviewApprovalInput = z.infer<typeof reviewApprovalSchema>;
