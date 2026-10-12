-- Reminders, adding to the schema in 20260930000100_init.sql.
--
-- A reminder is always derived from a real email: `email_id` is a reference to
-- the emails table, and the UI resolves the title and body from there rather
-- than storing a copy. That way editing or deleting the email cannot leave a
-- reminder pointing at text that no longer exists.

create table if not exists public.reminders (
  id         uuid primary key default gen_random_uuid(),
  -- Owning account. Scoped like every other read path in this schema: the
  -- caller is the verified session, never anything in a request body.
  user_email text        not null,

  -- The message this is about. ON DELETE CASCADE so removing the mail removes
  -- the reminder with it, rather than orphaning a row that renders blank.
  email_id   text        not null references public.emails (id) on delete cascade,

  -- Copied from the email for list rendering, so the sidebar badge does not
  -- need a join per row. Denormalised on purpose and refreshed by the store.
  title      text        not null default '',
  from_name  text        not null default '',

  -- When the thing being reminded about happens.
  due_at     timestamptz not null,

  -- How many days ahead to warn. The UI computes "days remaining" from due_at
  -- and this together, so the countdown needs no scheduled job to stay
  -- correct while the tab is open.
  remind_days_before integer not null default 1,

  note       text,

  -- 'pending' until fired, then 'done'. Dismissed reminders are 'dismissed' so
  -- they stop counting but stay visible until the email is gone.
  status     text        not null default 'pending',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint reminders_status_check
    check (status in ('pending', 'done', 'dismissed')),
  constraint reminders_days_check check (remind_days_before between 0 and 90)
);

-- The sidebar badge and the reminders list both read by owner, newest due
-- first. Composite so the common query is one index scan.
create index if not exists reminders_user_due_idx
  on public.reminders (user_email, due_at)
  where status = 'pending';

create index if not exists reminders_user_email_idx
  on public.reminders (user_email, email_id);

-- One reminder per message. Without this, a double-click on "remind me"
-- creates two rows and the badge shows 2 for one interview.
create unique index if not exists reminders_user_email_unique
  on public.reminders (user_email, email_id);

-- Deny by default, same as the other tables: the anon key ships in the
-- frontend bundle, and the service role is the only thing that reads this.
alter table public.reminders enable row level security;
