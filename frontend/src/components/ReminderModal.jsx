import React, { useState } from 'react';
import { Bell, X } from 'lucide-react';
import { remindersAPI } from '../services/api';

/**
 * "Remind me about this" dialog, opened from a message.
 *
 * The date defaults to tomorrow because a reminder for today is almost never
 * what someone means when they open this from an email, and an empty field
 * invites an error. Overdue dates are accepted: a user looking at yesterday's
 * interview mail may genuinely want to note it.
 *
 * The error from the server is shown rather than swallowed. If the save fails
 * and the dialog closes silently, the user believes a reminder exists that does
 * not.
 */
export default function ReminderModal({ email, existing, onClose, onSaved }) {
  const [dueAt, setDueAt] = useState(() => {
    if (existing?.due_at) return toDateInput(existing.due_at);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return toDateInput(tomorrow);
  });
  const [remindDaysBefore, setRemindDaysBefore] = useState(existing?.remind_days_before ?? 1);
  const [note, setNote] = useState(existing?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const today = toDateInput(new Date());

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      // Sent as local midnight, then converted to ISO by the helper. A bare date
      // string is parsed as UTC midnight by Date, which lands a day early or
      // late depending on the timezone.
      const saved = await remindersAPI.setReminder({
        emailId: email.id,
        dueAt: new Date(`${dueAt}T09:00:00`),
        remindDaysBefore,
        note: note.trim() || null,
      });
      onSaved?.(saved);
      onClose?.();
    } catch (e) {
      setError(e?.message || 'Could not save the reminder.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reminder-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-indigo-500" aria-hidden="true" />
            <h2 id="reminder-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
              {existing ? 'Edit reminder' : 'Set a reminder'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <p className="mb-4 truncate text-xs text-slate-500 dark:text-slate-400">
          {email.subject || '(no subject)'}
        </p>

        {error && (
          <p
            role="alert"
            className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
          >
            {error}
          </p>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Date
          </span>
          <input
            type="date"
            value={dueAt}
            min={today}
            onChange={(e) => setDueAt(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Remind me
          </span>
          <select
            value={remindDaysBefore}
            onChange={(e) => setRemindDaysBefore(Number(e.target.value))}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value={0}>On the day</option>
            <option value={1}>1 day before</option>
            <option value={2}>2 days before</option>
            <option value={3}>3 days before</option>
            <option value={7}>1 week before</option>
          </select>
        </label>

        <label className="mb-5 block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Note (optional)
          </span>
          <textarea
            value={note}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Bring printed copies"
            className="w-full resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dueAt}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? 'Saving…' : existing ? 'Update' : 'Set reminder'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Date -> "YYYY-MM-DD" in local time, which is what <input type=date> wants. */
function toDateInput(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
