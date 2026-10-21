/**
 * قوالب نصوص الإشعارات -- every notification string this module can send,
 * in one file, as the spec asks ("اجعل قائمة قوالب النصوص في ملف واحد").
 *
 * Pure and unit-tested: the wording a department head reads when their
 * request is returned is part of the product, not an incidental string
 * buried in an action.
 *
 * Arabic only for now. `notifications.message_en` exists and is nullable
 * precisely so an English pass can be added later without a migration —
 * these messages are generated at WRITE time, so nothing translates them
 * afterwards, and inventing half-English text now would be worse than
 * honestly leaving it null.
 */

import { requestStatusLabel, planStatusLabel } from "./recruitmentWorkflow";

export interface NotificationContent {
  type: string;
  messageAr: string;
  linkPath: string | null;
}

/** Trims a reason to keep a notification readable at a glance. */
function withReason(base: string, reason?: string | null): string {
  const trimmed = reason?.trim();
  if (!trimmed) return `${base}.`;
  const short = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  return `${base} — السبب: ${short}`;
}

/**
 * A request changed state. `jobTitle` is whatever the request is FOR (a
 * catalogue title or the free-text one), so the reader recognises which of
 * their requests this is without opening it.
 */
export function requestTransitionNotification(input: {
  toStatus: string;
  jobTitle: string;
  reason?: string | null;
}): NotificationContent {
  const { toStatus, jobTitle, reason } = input;
  const subject = `طلب الاحتياج «${jobTitle}»`;
  const linkPath = "/recruitment/requests";

  switch (toStatus) {
    case "under_hr_review":
      // The coordinator's submit lands here, and so does HR undoing its own
      // review — one message covers both, because for the reader the fact is
      // the same: the request is now on HR's desk.
      return {
        type: "recruitment_request_under_review",
        messageAr: `${subject} بانتظار مراجعة الموارد البشرية.`,
        linkPath,
      };
    case "hr_reviewed":
      return {
        type: "recruitment_request_hr_reviewed",
        messageAr: `أنهت الموارد البشرية مراجعة ${subject}، وهو بانتظار الاعتماد.`,
        linkPath,
      };
    case "returned_for_revision":
      return {
        type: "recruitment_request_returned",
        messageAr: withReason(`أُعيد ${subject} للتعديل`, reason),
        linkPath,
      };
    case "rejected":
      return { type: "recruitment_request_rejected", messageAr: withReason(`رُفض ${subject}`, reason), linkPath };
    case "approved":
      return {
        type: "recruitment_request_approved",
        messageAr: `تم اعتماد ${subject} وإدراجه في خطة التوظيف.`,
        linkPath,
      };
    default:
      // Never silently drop an unknown state: fall back to the shared status
      // vocabulary so a rule added later still produces a readable message.
      return {
        type: "recruitment_request_updated",
        messageAr: `تغيّرت حالة ${subject} إلى «${requestStatusLabel(toStatus)}».`,
        linkPath,
      };
  }
}

/** A plan changed state. `planName`/`planYear` identify it the way HR refers to it. */
export function planTransitionNotification(input: {
  toStatus: string;
  planName: string;
  planYear: number;
  planId: string;
  reason?: string | null;
}): NotificationContent {
  const { toStatus, planName, planYear, planId, reason } = input;
  const subject = `خطة التوظيف ${planYear} («${planName}»)`;
  const linkPath = `/recruitment/plan/${planId}`;

  switch (toStatus) {
    case "consolidated":
      return { type: "recruitment_plan_consolidated", messageAr: `تم دمج ${subject} وأصبحت جاهزة للرفع.`, linkPath };
    case "submitted":
      return {
        type: "recruitment_plan_submitted",
        messageAr: `رُفعت ${subject} للمراجعة المالية.`,
        linkPath,
      };
    case "finance_review":
      return { type: "recruitment_plan_finance_review", messageAr: `بدأت المراجعة المالية لـ${subject}.`, linkPath };
    case "returned_for_revision":
      return {
        type: "recruitment_plan_returned",
        // The spec's own worked example.
        messageAr: withReason(`أُعيدت ${subject} للتعديل`, reason),
        linkPath,
      };
    case "approved":
      return { type: "recruitment_plan_approved", messageAr: `تم اعتماد ${subject}.`, linkPath };
    case "rejected":
      return { type: "recruitment_plan_rejected", messageAr: withReason(`رُفضت ${subject}`, reason), linkPath };
    case "ready_for_execution":
      return {
        type: "recruitment_plan_ready",
        messageAr: `أصبحت ${subject} جاهزة للتنفيذ ويمكن نشر شواغرها.`,
        linkPath,
      };
    default:
      return {
        type: "recruitment_plan_updated",
        messageAr: `تغيّرت حالة ${subject} إلى «${planStatusLabel(toStatus)}».`,
        linkPath,
      };
  }
}

/** Finance recorded its review — HR and the approval authority both care. */
export function financeReviewNotification(input: {
  planName: string;
  planYear: number;
  planId: string;
  overBudget: boolean;
}): NotificationContent {
  const { planName, planYear, planId, overBudget } = input;
  return {
    type: "recruitment_plan_finance_reviewed",
    messageAr: overBudget
      ? `سجّلت الشؤون المالية مراجعتها لخطة التوظيف ${planYear} («${planName}») — الخطة تتجاوز الميزانية المعتمدة.`
      : `سجّلت الشؤون المالية مراجعتها لخطة التوظيف ${planYear} («${planName}»).`,
    linkPath: `/recruitment/plan/${planId}`,
  };
}

/* ------------------------------------------------------------------------
 * تقييم الأداء (2026-10-21, phase 2 item 7) — every state change tells the
 * next party, and the daily run reminds whoever holds the ball.
 * ---------------------------------------------------------------------- */

const evaluationStateMessageAr: Record<string, string> = {
  submitted: "أُرسل تقييم {name} ({cycle}) وهو بانتظار مراجعتك بصفتك الرئيس المباشر",
  supervisor_reviewed: "أنهى الرئيس المباشر مراجعة تقييم {name} ({cycle}) وهو بانتظار توصيتك",
  manager_recommended: "أوصى المدير بشأن تقييم {name} ({cycle}) وهو بانتظار مراجعة اللجنة",
  committee_reviewed: "راجعت اللجنة تقييم {name} ({cycle}) وهو بانتظار الاعتماد النهائي",
  approved: "اعتُمد تقييم {name} ({cycle}) وصارت نتيجته الرسمية متاحة",
  finalized: "أُقفل تقييم {name} ({cycle}) نهائيًّا",
  reopened: "أُعيد فتح تقييم {name} ({cycle}) إلى مرحلة سابقة",
};

function fill(template: string, name: string, cycle: string): string {
  return template.replace("{name}", name).replace("{cycle}", cycle);
}

/** An evaluation moved to `toState` (or was reopened — pass "reopened"). */
export function evaluationTransitionNotification(input: {
  toState: string;
  employeeName: string;
  cycleName: string;
  evaluationId: string;
  reason?: string | null;
}): NotificationContent {
  const template = evaluationStateMessageAr[input.toState] ?? "تغيّرت حالة تقييم {name} ({cycle})";
  const base = fill(template, input.employeeName, input.cycleName);
  return {
    type: `evaluation_${input.toState}`,
    messageAr: input.toState === "reopened" ? withReason(base, input.reason) : `${base}.`,
    linkPath: `/evaluations/${input.evaluationId}`,
  };
}

const reminderPhaseAr: Record<string, string> = {
  draft: "إرسال التقييم",
  submitted: "مراجعة الرئيس المباشر",
  supervisor_reviewed: "توصية المدير",
  manager_recommended: "مراجعة اللجنة",
  committee_reviewed: "الاعتماد النهائي",
  approved: "الإقفال النهائي",
};

/** A phase deadline is a week away, a day away, or has passed. */
export function evaluationReminderNotification(input: {
  kind: "week" | "day" | "overdue";
  state: string;
  employeeName: string;
  cycleName: string;
  deadline: string;
  evaluationId: string;
}): NotificationContent {
  const phase = reminderPhaseAr[input.state] ?? "المرحلة الحالية";
  const subject = `تقييم ${input.employeeName} (${input.cycleName})`;
  const when =
    input.kind === "week" ? `يحلّ موعد ${phase} خلال أسبوع (${input.deadline})` :
    input.kind === "day" ? `يحلّ موعد ${phase} غدًا أو اليوم (${input.deadline})` :
    `فات موعد ${phase} (${input.deadline}) ولم تُنجَز`;
  return {
    type: `evaluation_reminder_${input.kind}`,
    messageAr: `${subject}: ${when}.`,
    linkPath: `/evaluations/${input.evaluationId}`,
  };
}
