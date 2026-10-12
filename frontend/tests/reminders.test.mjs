/**
 * Reminder countdown tests.
 *
 * The date arithmetic is the part worth pinning, because "days remaining" is
 * what the whole feature shows and a wrong sign reads as a broken feature
 * rather than a wrong number.
 *
 * The cases use a fixed `now`, so they do not depend on when the suite runs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

const {
  daysRemaining,
  isWithinWindow,
  needsAttention,
  countdownLabel,
  countdownTone,
  sortByUrgency,
  attentionList,
  buildReminderPayload,
} = await import('../src/utils/reminders.js');

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    process.exitCode = 1;
  }
};

const NOW = new Date('2026-10-12T09:00:00Z').getTime();

check('days remaining is signed, so a past date is not a positive number', () => {
  // The original request showed October 8 with "4 days remaining" on a day
  // where October 8 had already passed. This is the assertion that catches it.
  assert.equal(daysRemaining('2026-10-08T09:00:00Z', NOW), -4);
  assert.equal(daysRemaining('2026-10-11T09:00:00Z', NOW), -1);
  assert.equal(daysRemaining('2026-10-12T09:00:00Z', NOW), 0);
  assert.equal(daysRemaining('2026-10-13T09:00:00Z', NOW), 1);
  assert.equal(daysRemaining('2026-10-18T09:00:00Z', NOW), 6);
});

check('a partial day rounds to the nearer day', () => {
  // 12 hours out is half a day and rounds to 1, not 0: an interview tomorrow
  // morning should read as "Tomorrow", not "Today".
  assert.equal(daysRemaining('2026-10-12T21:00:00Z', NOW), 1);
  // 16 hours out is closer to tomorrow than to today, so also 1.
  assert.equal(daysRemaining('2026-10-13T01:00:00Z', NOW), 1);
  // Six hours out rounds down to today, which is the other direction and the
  // reason rounding is used rather than a plain floor on the date.
  assert.equal(daysRemaining('2026-10-12T15:00:00Z', NOW), 0);
});

check('an unparseable date is zero rather than NaN', () => {
  assert.equal(daysRemaining('not a date', NOW), 0);
  assert.equal(daysRemaining(undefined, NOW), 0);
});

check('the notify window opens remind_days_before ahead and stays open', () => {
  assert.equal(isWithinWindow(6, 1), false);
  assert.equal(isWithinWindow(1, 1), true);
  assert.equal(isWithinWindow(0, 7), true);
  // Overdue still fires, so a missed interview is not silently dropped.
  assert.equal(isWithinWindow(-4, 1), true);
});

check('a wider warning widens the window', () => {
  assert.equal(isWithinWindow(3, 3), true);
  assert.equal(isWithinWindow(4, 3), false);
});

check('countdown labels read correctly in every band', () => {
  const label = (iso) => countdownLabel({ due_at: new Date(iso).toISOString() }, NOW);
  assert.equal(label('2026-10-13T09:00:00Z'), 'Tomorrow');
  assert.equal(label('2026-10-12T09:00:00Z'), 'Today');
  assert.equal(label('2026-10-18T09:00:00Z'), '6 days left');
  assert.equal(label('2026-10-11T09:00:00Z'), 'Yesterday');
  assert.equal(label('2026-10-10T09:00:00Z'), '2 days ago');
  assert.equal(label('2026-10-08T09:00:00Z'), '4 days ago');
});

check('the tone escalates from neutral to due to overdue', () => {
  const tone = (iso, remind = 1) =>
    countdownTone({ due_at: new Date(iso).toISOString(), remind_days_before: remind }, NOW);
  const far = tone('2026-10-25T09:00:00Z');
  const due = tone('2026-10-13T09:00:00Z');
  const late = tone('2026-10-08T09:00:00Z');
  assert.notEqual(far, due, 'a reminder inside its window should look different');
  assert.notEqual(due, late, 'an overdue reminder should look different again');
});

check('needsAttention ignores handled reminders', () => {
  assert.equal(needsAttention({ status: 'pending', days_remaining: 0 }), true);
  assert.equal(needsAttention({ status: 'done', days_remaining: 0 }), false);
  assert.equal(needsAttention({ status: 'dismissed', days_remaining: 0 }), false);
  assert.equal(needsAttention({ status: 'pending', days_remaining: 9 }), false);
  assert.equal(needsAttention(null), false);
});

check('reminders sort by due date, soonest first', () => {
  const rows = [
    { id: 'c', due_at: '2026-10-20T09:00:00Z' },
    { id: 'a', due_at: '2026-10-13T09:00:00Z' },
    { id: 'b', due_at: '2026-10-15T09:00:00Z' },
  ];
  assert.deepEqual(sortByUrgency(rows).map((r) => r.id), ['a', 'b', 'c']);
});

check('attentionList keeps only pending reminders inside their window', () => {
  const rows = [
    { id: 'soon', due_at: '2026-10-13T09:00:00Z', status: 'pending', remind_days_before: 1 },
    { id: 'later', due_at: '2026-11-30T09:00:00Z', status: 'pending', remind_days_before: 1 },
    { id: 'done', due_at: '2026-10-12T09:00:00Z', status: 'done', remind_days_before: 1 },
  ];
  assert.deepEqual(attentionList(rows, NOW).map((r) => r.id), ['soon']);
});

check('buildReminderPayload converts the date to ISO and validates it', () => {
  const p = buildReminderPayload({
    emailId: 'em-1',
    dueAt: new Date('2026-10-20T09:00:00Z'),
    remindDaysBefore: 3,
  });
  assert.equal(p.email_id, 'em-1');
  assert.equal(p.due_at, '2026-10-20T09:00:00.000Z');
  assert.equal(p.remind_days_before, 3);
});

check('buildReminderPayload refuses an unusable date rather than sending it', () => {
  // Caught in the form, so the user sees it, instead of becoming a 400 from the
  // server with nothing on screen.
  assert.throws(() => buildReminderPayload({ emailId: 'em-1', dueAt: 'nonsense' }));
  assert.throws(() => buildReminderPayload({ emailId: 'em-1', dueAt: null }));
  assert.throws(() => buildReminderPayload({ emailId: null, dueAt: new Date() }));
});

check('a negative warning window falls back to one day', () => {
  const p = buildReminderPayload({
    emailId: 'em-1',
    dueAt: new Date('2026-10-20T09:00:00Z'),
    remindDaysBefore: -5,
  });
  assert.equal(p.remind_days_before, 1);
});

check('the client calls the reminder endpoints the API actually serves', () => {
  const api = read('../src/services/api.js');
  for (const route of [
    '/api/reminders',
    '/complete',
    '/dismiss',
  ]) {
    assert.ok(api.includes(route), `remindersAPI does not call ${route}`);
  }
  // The unique index on (user_email, email_id) makes this an upsert, so a
  // double-click updates rather than creating a second reminder.
  const store = read('../../supabase/functions/api/_shared/store.js');
  assert.ok(
    /onConflict:\s*"user_email,email_id"/.test(store),
    'setReminder must upsert on the unique index',
  );
});

check('the schema has the unique constraint the upsert depends on', () => {
  const sql = read('../../supabase/migrations/20261012000100_reminders.sql');
  assert.ok(/unique index.*reminders_user_email_unique/i.test(sql));
  assert.ok(/on delete cascade/i.test(sql), 'deleting the email should remove its reminder');
  assert.ok(/enable row level security/i.test(sql));
});

console.log(
  failures.length
    ? `  FAILURES\n${failures.map((f) => `    - ${f}`).join('\n')}`
    : `  ${passed} reminder checks passed`,
);
