import type { SupabaseClient } from "@supabase/supabase-js";
import { deadlineForState, reminderKind, type CycleDeadlines, type ReminderKind } from "./evaluationDeadlines";
import { evaluationReminderNotification } from "./notificationTemplates";
import type { EvaluationState } from "./vpra";

/**
 * Daily reminder run (phase 2 item 7). Runs with the SERVICE-ROLE client:
 * it reads every open evaluation of every cycle that carries deadlines,
 * works out which reminder (week / day / overdue) is due today for the
 * evaluation's current phase, asks the database who must act
 * (`evaluation_actor_profile_ids`, the same relationship the state trigger
 * enforces), and writes one in-app notification per recipient — never twice
 * for the same kind, evaluation and recipient.
 *
 * Triggered by POST /api/evaluations/reminders (secret-protected; the Netlify
 * scheduled function calls it every morning) and by the HR button on the
 * cycle page.
 */
export interface ReminderRunOutcome {
  cycles: number;
  evaluationsChecked: number;
  due: number;
  sent: number;
  skippedAlreadySent: number;
}

type CycleRow = CycleDeadlines & { id: string; name_ar: string };
type EvaluationRow = { id: string; state: EvaluationState; employee_id: string; cycle_id: string; profiles: { full_name_ar: string } | null };

export async function runEvaluationReminders(admin: SupabaseClient, today: string, cycleId?: string): Promise<ReminderRunOutcome> {
  let cyclesQuery = admin
    .from("evaluation_cycles")
    .select("id, name_ar, deadline_submit, deadline_supervisor, deadline_recommend, deadline_approve")
    .is("deleted_at", null)
    .or("deadline_submit.not.is.null,deadline_supervisor.not.is.null,deadline_recommend.not.is.null,deadline_approve.not.is.null");
  if (cycleId) cyclesQuery = cyclesQuery.eq("id", cycleId);
  const { data: cycleRows } = await cyclesQuery;
  const cycles = (cycleRows ?? []) as CycleRow[];
  const outcome: ReminderRunOutcome = { cycles: cycles.length, evaluationsChecked: 0, due: 0, sent: 0, skippedAlreadySent: 0 };
  if (cycles.length === 0) return outcome;

  const { data: evaluationRows } = await admin
    .from("evaluations")
    .select("id, state, employee_id, cycle_id, profiles(full_name_ar)")
    .in("cycle_id", cycles.map((c) => c.id))
    .neq("state", "finalized")
    .is("deleted_at", null);
  const evaluations = (evaluationRows ?? []) as unknown as EvaluationRow[];
  outcome.evaluationsChecked = evaluations.length;
  const cycleById = new Map(cycles.map((c) => [c.id, c]));

  const due: Array<{ evaluation: EvaluationRow; cycle: CycleRow; kind: ReminderKind; deadline: string }> = [];
  for (const evaluation of evaluations) {
    const cycle = cycleById.get(evaluation.cycle_id);
    if (!cycle) continue;
    const deadline = deadlineForState(cycle, evaluation.state);
    const kind = reminderKind(deadline, today);
    if (kind && deadline) due.push({ evaluation, cycle, kind, deadline });
  }
  outcome.due = due.length;
  if (due.length === 0) return outcome;

  // What was already sent, so a daily run never repeats the same reminder.
  const { data: sentRows } = await admin
    .from("notifications")
    .select("recipient_id, entity_id, type")
    .eq("entity_type", "evaluation_reminder")
    .in("entity_id", due.map((d) => d.evaluation.id))
    .is("deleted_at", null);
  const alreadySent = new Set(((sentRows ?? []) as { recipient_id: string; entity_id: string; type: string }[]).map((r) => `${r.recipient_id}::${r.entity_id}::${r.type}`));

  const inserts: Array<{ recipient_id: string; entity_type: string; entity_id: string; type: string; message_ar: string; link_path: string | null }> = [];
  for (const item of due) {
    const { data: actorIds } = await admin.rpc("evaluation_actor_profile_ids", { p_evaluation_id: item.evaluation.id, p_state: item.evaluation.state });
    const recipients = [...new Set(((actorIds ?? []) as unknown as Array<string | { evaluation_actor_profile_ids: string }>).map((r) => (typeof r === "string" ? r : r.evaluation_actor_profile_ids)))];
    const content = evaluationReminderNotification({
      kind: item.kind,
      state: item.evaluation.state,
      employeeName: item.evaluation.profiles?.full_name_ar ?? "—",
      cycleName: item.cycle.name_ar,
      deadline: item.deadline,
      evaluationId: item.evaluation.id,
    });
    for (const recipient of recipients) {
      const key = `${recipient}::${item.evaluation.id}::${content.type}`;
      if (alreadySent.has(key)) {
        outcome.skippedAlreadySent += 1;
        continue;
      }
      alreadySent.add(key);
      inserts.push({ recipient_id: recipient, entity_type: "evaluation_reminder", entity_id: item.evaluation.id, type: content.type, message_ar: content.messageAr, link_path: content.linkPath });
    }
  }
  for (let i = 0; i < inserts.length; i += 200) {
    const batch = inserts.slice(i, i + 200);
    const { error } = await admin.from("notifications").insert(batch);
    if (error) console.error("runEvaluationReminders: insert failed", error.message);
    else outcome.sent += batch.length;
  }
  return outcome;
}
