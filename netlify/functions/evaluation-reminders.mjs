// Netlify scheduled function: fires the daily evaluation reminder run
// (phase 2 item 7). 06:00 UTC = 09:00 Riyadh. It only knocks on the app's
// own route with the shared secret; the logic lives in the app
// (src/lib/evaluationReminders.ts), so the same run can also be started by
// hand from the cycle page.
//
// Needs two site environment variables: URL (set by Netlify itself) and
// EVALUATION_REMINDER_SECRET (the same value the route checks).
export default async function handler() {
  const base = process.env.URL;
  const secret = process.env.EVALUATION_REMINDER_SECRET;
  if (!base || !secret) {
    console.log("evaluation-reminders: URL or EVALUATION_REMINDER_SECRET missing — skipped");
    return new Response("skipped", { status: 200 });
  }
  const res = await fetch(`${base}/api/evaluations/reminders`, { method: "POST", headers: { "x-reminder-secret": secret } });
  const body = await res.text();
  console.log(`evaluation-reminders: ${res.status} ${body}`);
  return new Response(body, { status: res.ok ? 200 : 500 });
}

export const config = { schedule: "0 6 * * *" };
