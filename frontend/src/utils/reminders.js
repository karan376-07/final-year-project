/**
 * Reminder countdown helpers for the browser.
 *
 * Mirrors supabase/functions/api/_shared/reminders.js so the UI and the API
 * agree on what "3 days left" means. Kept as a separate copy rather than
 * imported because the frontend is bundled by Vite, which does not resolve the
 * `npm:`/`jsr:` specifiers the edge function uses. The two are held in step by
 * the shared test cases, not by a build step.
 *
 * The countdown is computed on read, never stored, so it cannot go stale while
 * the tab sits open. A reminder whose date has passed reads as overdue rather
 * than as a positive number of days.
 */

/** Milliseconds in a day. */
export const MS_PER_DAY = 86_400_000;

/**
 * Whole days from now until `dueAt`, rounded toward zero and signed.
 *
 * 23 hours away is "1 day left" rather than 0; a date already past is negative.
 */
export function daysRemaining(dueAt, now = Date.now()) {
  const due = dueAt instanceof Date ? dueAt.getTime() : new Date(dueAt).getTime();
  if (!Number.isFinite(due)) return 0;
  return Math.round((due - now) / MS_PER_DAY);
}

/**
 * Whether the reminder is inside its warning window.
 *
 * `remindDaysBefore: 1` means "warn me a day ahead", so the window opens one
 * day out and stays open. Overdue reminders still count, so nothing is missed
 * silently.
 */
export function isWithinWindow(days, remindDaysBefore = 1) {
  return days <= Number(remindDaysBefore ?? 0);
}

/** True when the reminder still needs attention: pending and inside its window. */
export function needsAttention(reminder) {
  if (!reminder) return false;
  if (reminder.status !== 'pending') return false;
  return isWithinWindow(
    Number(reminder.days_remaining ?? 0),
    reminder.remind_days_before,
  );
}

/** "Tomorrow", "Today", "6 days left", "4 days ago". */
export function countdownLabel(reminder, now = Date.now()) {
  const days = daysRemaining(reminder?.due_at ?? reminder?.due_date, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return `${Math.abs(days)} days ago`;
  return `${days} days left`;
}

/** Tailwind classes for the countdown chip, by urgency. */
export function countdownTone(reminder, now = Date.now()) {
  const days = daysRemaining(reminder?.due_at ?? reminder?.due_date, now);
  if (days < 0) return 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300';
  if (days <= (Number(reminder?.remind_days_before ?? 1))) {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
  }
  return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
}

/** "October 8, 2026" in the user's locale, or a dash when unparseable. */
export function formatDueDate(dueAt) {
  const d = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Build the request body for setting a reminder.
 *
 * Validated here so a malformed date is caught in the form rather than becoming
 * a 400 from the server with no explanation on screen.
 */
export function buildReminderPayload({ emailId, dueAt, remindDaysBefore = 1, note = null }) {
  if (!emailId) throw new Error('emailId is required');
  if (!dueAt) throw new Error('dueAt is required');
  const parsed = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) throw new Error('dueAt is not a valid date');
  const days = Number(remindDaysBefore);
  return {
    email_id: emailId,
    due_at: parsed.toISOString(),
    remind_days_before: Number.isFinite(days) && days >= 0 ? Math.floor(days) : 1,
    note: note || null,
  };
}

/**
 * Reminders inside their window, soonest first.
 *
 * Sorted by due date rather than by how close they are, so the list reads as a
 * schedule.
 */
export function sortByUrgency(reminders, now = Date.now()) {
  return [...(reminders ?? [])].sort((a, b) => {
    const da = new Date(a.due_at ?? a.due_date).getTime();
    const db = new Date(b.due_at ?? b.due_date).getTime();
    return (Number.isFinite(da) ? da : Infinity) - (Number.isFinite(db) ? db : Infinity);
  });
}

/** Reminders that want the user to do something now. */
export function attentionList(reminders, now = Date.now()) {
  return sortByUrgency(reminders, now).filter((r) => {
    if (r.status !== 'pending') return false;
    return isWithinWindow(
      daysRemaining(r.due_at ?? r.due_date, now),
      r.remind_days_before,
    );
  });
}
