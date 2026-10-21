import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runEvaluationReminders } from "@/lib/evaluationReminders";
import { todayInTimezone } from "@/lib/evaluationCycle";

/**
 * POST /api/evaluations/reminders — the daily reminder run (phase 2 item 7).
 *
 * Not a user endpoint: it is called by the Netlify scheduled function
 * (netlify/functions/evaluation-reminders.mjs, every morning) or by an
 * operator with the shared secret. Without `EVALUATION_REMINDER_SECRET` in the
 * environment the route is disabled (503) rather than open. The work itself
 * runs under the service role; see runEvaluationReminders for what it sends.
 */
export async function POST(request: Request) {
  const secret = process.env.EVALUATION_REMINDER_SECRET;
  if (!secret) return NextResponse.json({ error: "reminders_disabled" }, { status: 503 });
  const provided = request.headers.get("x-reminder-secret") ?? "";
  if (provided.length !== secret.length || provided !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const admin = createAdminClient();
  const outcome = await runEvaluationReminders(admin, todayInTimezone("Asia/Riyadh"));
  await admin.from("audit_log").insert({ action: "evaluation_reminders_run", entity: "evaluation_cycles", after_data: { source: "schedule", ...outcome } });
  return NextResponse.json({ ok: true, ...outcome });
}
