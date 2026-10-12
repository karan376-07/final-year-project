/**
 * Reminder countdown helpers.
 *
 * The date maths is here rather than in the store so it can be tested without a
 * database, and so the UI and the API agree on what "3 days left" means.
 *
 * A countdown is computed on read, never stored. There is no scheduled job
 * rewriting rows as the clock moves, so a reminder stays correct for as long as
 * the tab is open, and a stale countdown can never be shown.
 */

/** Milliseconds in a day. */
export const MS_PER_DAY = 86_400_000;

/**
 * Whole days from now until `dueAt`.
 *
 * Rounded toward zero, so 23 hours away reads as "1 day left" rather than 0.
 * Signed: a date already past is negative, and the UI shows that as overdue
 * rather than silently reporting zero.
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
 * day out and stays open. That includes overdue reminders deliberately: a
 * reminder for last Tuesday should still surface, or it is missed silently.
 */
export function isWithinWindow(days, remindDaysBefore = 1) {
    return days <= Number(remindDaysBefore ?? 0);
}

/** True when the reminder still needs the user's attention. */
export function needsAttention(reminder) {
    if (!reminder) return false;
    if (reminder.status !== "pending") return false;
    return isWithinWindow(
        Number(reminder.days_remaining ?? 0),
        reminder.remind_days_before,
    );
}

/** "Tomorrow", "Today", "6 days left", "4 days ago". */
export function countdownLabel(reminder) {
    const days = Number(reminder?.days_remaining ?? 0);
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days === -1) return "Yesterday";
    if (days < 0) return `${Math.abs(days)} days ago`;
    return `${days} days left`;
}

/**
 * Build a reminder payload from an email.
 *
 * Used by the UI when the user clicks "remind me" on a message, so the date
 * the user picks is converted to the ISO form the API expects rather than each
 * call site formatting it differently.
 */
export function buildReminderPayload({ emailId, dueAt, remindDaysBefore = 1, note = null }) {
    if (!emailId) throw new Error("emailId is required");
    if (!dueAt) throw new Error("dueAt is required");
    const parsed = dueAt instanceof Date ? dueAt : new Date(dueAt);
    if (Number.isNaN(parsed.getTime())) throw new Error("dueAt is not a valid date");
    const days = Number(remindDaysBefore);
    return {
        email_id: emailId,
        due_at: parsed.toISOString(),
        remind_days_before: Number.isFinite(days) && days >= 0 ? Math.floor(days) : 1,
        note: note || null,
    };
}
