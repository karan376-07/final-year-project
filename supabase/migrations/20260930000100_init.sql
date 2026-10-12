-- Smart Email Assistant, Supabase schema.
--
-- Ported from the Firestore documents used by the Cloud Functions version.
-- Nested structures that Firestore stored as sub-documents become jsonb, so
-- the shapes the API already returns are preserved exactly.
--
-- Apply with: supabase db push   (or paste into the SQL editor)

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------ emails
create table if not exists public.emails (
  id              text primary key,
  -- Owning account. Every read and write path is scoped by this column, so it
  -- must always be set by the route or the sync layer rather than trusted from
  -- a request body. Without it there is nothing to authorise against.
  user_email      text        not null,
  sender_name     text        not null default '',
  sender_email    text        not null default '',
  recipient_email text        not null default '',
  subject         text        not null default '',
  snippet         text        not null default '',
  body            text        not null default '',
  category        text        not null default 'Work',
  priority        text        not null default 'Medium',
  date            timestamptz,
  -- Unix seconds. 0 means "no date" and is excluded from bounded date ranges.
  ts              double precision not null default 0,
  is_read         boolean     not null default false,
  is_starred      boolean     not null default false,
  is_spam         boolean     not null default false,
  is_trash        boolean     not null default false,
  has_attachments boolean     not null default false,
  attachments     jsonb       not null default '[]'::jsonb,
  summary         jsonb,
  action_items    jsonb       not null default '[]'::jsonb,
  reply_draft     text,
  folder          text        not null default 'inbox',
  -- Derived index. Firestore had no substring search, so the token array is
  -- used as a coarse prefilter and the exact substring test still runs in
  -- memory afterwards. Never written by a client.
  search_tokens   text[]      not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint emails_category_check check (
    category in ('Work','Personal','Promotions','Finance','Updates','Newsletter',
                 'Important','Meeting','Invitation','Spam','Other')
  ),
  constraint emails_priority_check check (priority in ('High','Medium','Low'))
);

-- The project may already contain the legacy emails table. Keep this
-- migration safe to rerun while bringing that table up to the current shape.
alter table public.emails
  add column if not exists sender_name text not null default '',
  add column if not exists sender_email text not null default '',
  add column if not exists recipient_email text not null default '',
  add column if not exists subject text not null default '',
  add column if not exists snippet text not null default '',
  add column if not exists body text not null default '',
  add column if not exists category text not null default 'Work',
  add column if not exists priority text not null default 'Medium',
  add column if not exists date timestamptz,
  add column if not exists ts double precision not null default 0,
  add column if not exists is_read boolean not null default false,
  add column if not exists is_starred boolean not null default false,
  add column if not exists is_spam boolean not null default false,
  add column if not exists is_trash boolean not null default false,
  add column if not exists has_attachments boolean not null default false,
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists summary jsonb,
  add column if not exists action_items jsonb not null default '[]'::jsonb,
  add column if not exists reply_draft text,
  add column if not exists folder text not null default 'inbox',
  add column if not exists search_tokens text[] not null default '{}',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Older deployments used this JSON payload column as the canonical email
-- document. Keep it populated for compatibility while normalized columns are
-- used by the current API.
alter table public.emails
  add column if not exists data text not null default '{}';

-- Every read is scoped by owner first, so this leads most of the indexes.
create index if not exists emails_user_folder_idx
  on public.emails (user_email, folder);
create index if not exists emails_user_ts_idx
  on public.emails (user_email, ts desc);
create index if not exists emails_user_category_idx
  on public.emails (user_email, category);
create index if not exists emails_user_priority_idx
  on public.emails (user_email, priority);
create index if not exists emails_user_unread_idx
  on public.emails (user_email, is_read) where folder = 'inbox';
create index if not exists emails_user_starred_idx
  on public.emails (user_email) where is_starred = true;
-- GIN so the search prefilter uses an index rather than a sequential scan.
create index if not exists emails_search_tokens_idx
  on public.emails using gin (search_tokens);

-- ----------------------------------------------------------- sent replies
-- The corpus style learning is built from. Only delivered mail is recorded.
create table if not exists public.sent_replies (
  id         text primary key,
  user_email text        not null,
  to_addr    text        not null default '',
  subject    text        not null default '',
  body       text        not null,
  sent       boolean     not null default true,
  created_at timestamptz not null default now()
);

create index if not exists sent_replies_user_created_idx
  on public.sent_replies (user_email, created_at desc);

-- ------------------------------------------------------------ credentials
-- OAuth refresh tokens, sealed with AES-256-GCM before they get here.
-- A refresh token outlives the session that created it, so it is never stored
-- in the clear.
create table if not exists public.credentials (
  user_email    text primary key,
  refresh_token text,
  access_token  text,
  scope         text,
  expiry_date   bigint,
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- settings
-- Per account. The Python version mutated a process-wide dict, which meant one
-- user's settings were visible to the next.
create table if not exists public.user_settings (
  user_email         text primary key,
  demo_mode          boolean not null default false,
  gemini_api_key     text    not null default '',
  auto_reply_enabled boolean not null default true,
  default_reply_tone text    not null default 'Professional',
  connected_gmail    boolean not null default false,
  sync_interval_mins integer not null default 15,
  updated_at         timestamptz not null default now()
);

-- ------------------------------------------------------------------- RLS
-- Deny by default. The edge function connects with the service role key, which
-- bypasses RLS, so the correct posture is that no client -- web, mobile, or a
-- curl holding the anon key -- can read or write anything.
--
-- This is not theoretical: the anon key ships inside the frontend bundle, so
-- any policy permitting a read is a policy that publishes every user's mail.
alter table public.emails        enable row level security;
alter table public.sent_replies  enable row level security;
alter table public.credentials   enable row level security;
alter table public.user_settings enable row level security;

do $$
begin
  -- No policies are created on purpose. With RLS enabled and zero policies,
  -- every statement from a client role is rejected.
  raise notice 'RLS enabled with no policies: clients are denied, service role bypasses.';
end $$;
