/**
 * Reminder tests.
 *
 * The date arithmetic is the part worth pinning. "Days remaining" is computed on
 * every read rather than stored, so it has to stay correct as time passes
 * without a scheduled job, and it has to stay signed -- a reminder for a date
 * that has gone by must read as overdue, not as a positive number of days.
 */

import { assertEquals } from "@std/assert";
import { countdownLabel, daysRemaining, isWithinWindow, needsAttention } from "./reminders.js";

/** A fixed now, so the assertions do not depend on when the suite runs. */
const NOW = new Date("2026-10-12T09:00:00Z").getTime();

/** [label, due_at ISO, expected] */
const DAY_CASES = [
    ["tomorrow is 1 day", "2026-10-13T09:00:00Z", 1],
    ["today is 0 days", "2026-10-12T09:00:00Z", 0],
    ["in six days", "2026-10-18T09:00:00Z", 6],
    // The case the original example got wrong: October 8 has already passed on
    // October 12, so this must be negative, not positive.
    ["a date four days gone is -4, not +4", "2026-10-08T09:00:00Z", -4],
    ["yesterday is -1", "2026-10-11T09:00:00Z", -1],
];

for (const [label, due, expected] of DAY_CASES) {
    Deno.test(`days remaining: ${label}`, () => {
        assertEquals(daysRemaining(due, NOW), expected);
    });
}

/** [label, due_at ISO, remind_days_before, expected] */
const WINDOW_CASES = [
    ["six days out with a 1-day warning is not yet due", "2026-10-18T09:00:00Z", 1, false],
    ["exactly one day out with a 1-day warning fires", "2026-10-13T09:00:00Z", 1, true],
    ["today fires regardless of the window", "2026-10-12T09:00:00Z", 7, true],
    ["an overdue reminder still fires, so it is not missed silently", "2026-10-08T09:00:00Z", 1, true],
    ["same-day with a 0-day warning fires", "2026-10-12T09:00:00Z", 0, true],
    ["three days out with a 3-day warning fires", "2026-10-15T09:00:00Z", 3, true],
    ["four days out with a 3-day warning does not", "2026-10-16T09:00:00Z", 3, false],
];

for (const [label, due, remind, expected] of WINDOW_CASES) {
    Deno.test(`notify window: ${label}`, () => {
        assertEquals(isWithinWindow(daysRemaining(due, NOW), remind), expected);
    });
}

Deno.test("a reminder renders a human label for its countdown", () => {
    const build = (dueIso) => ({ days_remaining: daysRemaining(dueIso, NOW) });
    assertEquals(countdownLabel(build("2026-10-13T09:00:00Z")), "Tomorrow");
    assertEquals(countdownLabel(build("2026-10-12T09:00:00Z")), "Today");
    assertEquals(countdownLabel(build("2026-10-18T09:00:00Z")), "6 days left");
    assertEquals(countdownLabel(build("2026-10-11T09:00:00Z")), "Yesterday");
    assertEquals(countdownLabel(build("2026-10-10T09:00:00Z")), "2 days ago");
    // The example in the original request: October 8 viewed on October 12.
    assertEquals(countdownLabel(build("2026-10-08T09:00:00Z")), "4 days ago");
});

Deno.test("the notify window ignores reminders already handled", () => {
    assertEquals(needsAttention({ status: "pending", days_remaining: 0 }), true);
    assertEquals(needsAttention({ status: "done", days_remaining: 0 }), false);
    assertEquals(needsAttention({ status: "dismissed", days_remaining: 0 }), false);
    assertEquals(needsAttention({ status: "pending", days_remaining: 9 }), false);
    assertEquals(needsAttention(null), false);
});
