import React, { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, Check, Trash2, X } from 'lucide-react';
import { remindersAPI } from '../services/api';
import {
  attentionList,
  countdownLabel,
  countdownTone,
  formatDueDate,
  sortByUrgency,
} from '../utils/reminders';

/**
 * The reminder list.
 *
 * The countdown is recomputed on a timer rather than read from the stored
 * value, because the server computed `days_remaining` when it served the row and
 * that goes stale as the clock moves. One minute is enough resolution for a
 * day-scale countdown and costs nothing.
 *
 * Errors are surfaced rather than swallowed. A reminder that silently failed to
 * save would leave the user believing an interview was noted down.
 */
const TICK_MS = 60_000;

export default function ReminderPanel({ onOpenEmail, onCountChange }) {
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showHandled, setShowHandled] = useState(false);
  // Bumped each tick to force the countdown labels to recompute.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setError(null);
      const { reminders: items, pending_count: pending } = await remindersAPI.getReminders();
      setReminders(items);
      onCountChange?.(pending);
    } catch (e) {
      setError(e?.message || 'Could not load reminders.');
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const act = useCallback(async (fn, label) => {
    try {
      setError(null);
      await fn();
      await load();
    } catch (e) {
      setError(e?.message || `${label} failed.`);
    }
  }, [load]);

  const upcoming = sortByUrgency(reminders, now);
  const due = attentionList(reminders, now);
  const handled = upcoming.filter((r) => r.status !== 'pending');

  return (
    <section className="flex flex-col gap-4" aria-label="Reminders">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Reminders
        </h2>
        <button
          type="button"
          onClick={() => setShowHandled((v) => !v)}
          className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          {showHandled ? 'Hide handled' : `Show handled (${handled.length})`}
        </button>
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          {error}
        </p>
      )}

      {loading && (
        <p className="text-xs text-slate-500 dark:text-slate-400">Loading reminders…</p>
      )}

      {!loading && !upcoming.length && !error && (
        <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-8 text-center dark:border-slate-700">
          <BellOff className="mx-auto mb-2 h-5 w-5 text-slate-400" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-300">No reminders yet</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Open an email and set a reminder on it.
          </p>
        </div>
      )}

      {due.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20">
          <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">
            Needs attention
          </p>
          <ReminderList
            items={due}
            now={now}
            onOpenEmail={onOpenEmail}
            onComplete={(r) => act(() => remindersAPI.complete(r.id), 'Complete')}
            onDismiss={(r) => act(() => remindersAPI.dismiss(r.id), 'Dismiss')}
          />
        </div>
      )}

      {upcoming.length > due.length && (
        <div>
          <p className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-400">
            Coming up
          </p>
          <ReminderList
            items={upcoming.filter((r) => !due.includes(r))}
            now={now}
            onOpenEmail={onOpenEmail}
            onComplete={(r) => act(() => remindersAPI.complete(r.id), 'Complete')}
            onDismiss={(r) => act(() => remindersAPI.dismiss(r.id), 'Dismiss')}
          />
        </div>
      )}

      {showHandled && handled.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-500">
            Handled
          </p>
          <ReminderList
            items={handled}
            now={now}
            muted
            onOpenEmail={onOpenEmail}
            onRemove={(r) => act(() => remindersAPI.remove(r.id), 'Remove')}
          />
        </div>
      )}
    </section>
  );
}

function ReminderList({ items, now, onOpenEmail, onComplete, onDismiss, onRemove, muted }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((r) => (
        <li
          key={r.id}
          className={`flex items-start gap-3 rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-700 dark:bg-slate-900/50 ${
            muted ? 'opacity-60' : ''
          }`}
        >
          <Bell className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {onOpenEmail ? (
              <button
                type="button"
                onClick={() => onOpenEmail(r.email_id)}
                className="block max-w-full truncate text-left text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
              >
                {r.title || '(no subject)'}
              </button>
            ) : (
              <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                {r.title || '(no subject)'}
              </p>
            )}
            {r.from_name && (
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                {r.from_name}
              </p>
            )}
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>{formatDueDate(r.due_at)}</span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${countdownTone(r, now)}`}
              >
                {countdownLabel(r, now)}
              </span>
              {r.remind_days_before > 0 && (
                <span className="text-slate-400">
                  {r.remind_days_before === 1
                    ? '1 day before'
                    : `${r.remind_days_before} days before`}
                </span>
              )}
            </p>
            {r.note && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {r.note}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onComplete && r.status === 'pending' && (
              <IconButton label="Mark done" onClick={() => onComplete(r)}>
                <Check className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            )}
            {onDismiss && r.status === 'pending' && (
              <IconButton label="Dismiss" onClick={() => onDismiss(r)}>
                <X className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            )}
            {onRemove && (
              <IconButton label="Remove" onClick={() => onRemove(r)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function IconButton({ label, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}
