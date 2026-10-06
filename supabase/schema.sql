-- Matchday Briefing schema (SPEC.md §2). Run in the Supabase SQL Editor.
-- Safe to re-run: types, tables, columns and indexes are created only if missing, and policies
-- and grants are re-applied with the same definitions. Nothing that holds data is dropped or
-- deleted. The whole file is one transaction, so if any statement fails, none of it is applied.
--
-- Project settings this file assumes:
--   * "Automatically expose new tables" is OFF, so no role gets table privileges
--     by default. Every privilege the Data API needs is granted explicitly below.
--   * Automatic RLS is ON. RLS is still enabled explicitly here so the file is
--     correct on a project without that setting.
--
-- Access model:
--   anon          (publishable key, used by the frontend): SELECT on teams/matches/comments,
--                 INSERT only on feedback/sessions. No UPDATE/DELETE anywhere.
--   service_role  (secret key, used only by pipeline and check scripts): full DML.
--                 It bypasses RLS, but still needs table GRANTs.
--   authenticated: nothing. This build has no accounts.
--   players and match_events (Revision 9) are service_role only: the frontend doesn't read them,
--                 and birth_date is personal data.

begin;

-- ---------------------------------------------------------------- types

do $$ begin
  create type match_status as enum ('scheduled', 'in_play', 'finished', 'postponed', 'cancelled', 'other');
exception when duplicate_object then null; end $$;
-- API statuses are mapped into these by STATUS_MAP (§2.2); only 'finished' is eligible for generation

do $$ begin
  create type comment_type as enum ('STAT', 'BANTER', 'HOT_TAKE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type checker_status as enum ('passed');
exception when duplicate_object then null; end $$;
-- only passed rows are ever written; failed candidates are logged to stdout in the pipeline run, not persisted

do $$ begin
  create type player_data_status as enum ('pending', 'ok', 'mismatch', 'unavailable');
exception when duplicate_object then null; end $$;
-- §2.3; the §3.1 generation gate needs 'ok', 'mismatch' or 'unavailable'

do $$ begin
  create type match_event_type as enum ('goal', 'own_goal', 'assist', 'red_card', 'pen_missed', 'pen_saved', 'saves');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- tables

create table if not exists teams (
  id text primary key,                -- football-data.org team id
  name text not null,                 -- full name as the API returns it
  short_name text not null,           -- API shortName; shown in the picker and on match cards
  tla text not null,                  -- API three-letter code, e.g. 'ARS'
  slug text not null unique,          -- §2.1; assigned once on insert, never changed
  in_current_season boolean not null, -- true if in the latest competition-teams response
  updated_at timestamptz not null
);

create table if not exists matches (
  id text primary key,               -- football-data.org match id
  competition text not null,         -- e.g. 'PL'
  matchday int,                      -- API matchday (round number); null if the API omits it
  home_team_id text not null references teams(id),
  away_team_id text not null references teams(id),
  home_score int,                    -- full time
  away_score int,                    -- full time
  home_ht_score int,                 -- half time; null if the free tier doesn't return it (confirmed in P0)
  away_ht_score int,
  kickoff_at timestamptz not null,
  status match_status not null,
  api_status text not null,          -- raw API status, kept for debugging the mapping
  home_generation_attempts int not null default 0,  -- §3.1 retry cap, per perspective
  away_generation_attempts int not null default 0,
  data_fetched_at timestamptz not null
);

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  match_id text not null references matches(id),
  perspective_team_id text not null references teams(id),  -- which team's fans this line is framed for
  type comment_type not null,
  text text not null,
  note text not null,                 -- type-tailored explanation shown under the line
  checker_status checker_status not null default 'passed',
  prompt_version text not null,       -- PROMPT_VERSION at generation time (§3.5)
  superseded_at timestamptz,          -- set when a score correction invalidates the line (§3.6)
  created_at timestamptz not null default now()
);

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references comments(id),
  device_id uuid not null,            -- anonymous, generated client-side, stored in localStorage
  reaction text not null check (reaction in ('up', 'down')),
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null,            -- same anonymous id as feedback
  installed boolean not null,         -- true when running as an installed PWA (display-mode: standalone)
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- Revision 9: FPL player data (§2.3)
-- Columns are added only if missing. Existing matches take the default 'pending', so the first run
-- stores their FPL events; their comments aren't touched.

alter table teams add column if not exists fpl_team_id int;        -- FPL's team id this season; null if not one of FPL's 20
alter table teams add column if not exists fpl_team_code int;      -- FPL's team code

alter table matches add column if not exists fpl_fixture_id int;   -- the FPL fixture it paired with; null until the cross-check runs
alter table matches add column if not exists player_data player_data_status not null default 'pending';
alter table matches add column if not exists finished_seen_at timestamptz;  -- first stored as finished; null if before Revision 9
alter table matches add column if not exists fpl_data_at timestamptz;       -- when FPL's full-time data was cross-checked

create table if not exists players (  -- upserted from FPL's bootstrap-static every run, never deleted
  fpl_id int primary key,             -- FPL element id; FPL renumbers these every season
  web_name text not null,             -- FPL's short display name; not unique
  first_name text not null,
  second_name text not null,
  known_name text,                    -- FPL's "known as" full name; null when FPL gives none
  birth_date date,                    -- null when FPL gives none; such a player counts as under 18 (§3.3 N5)
  updated_at timestamptz not null
);

create table if not exists match_events (  -- written only when the match's score cross-check passes
  match_id text not null references matches(id),
  fpl_id int not null references players(fpl_id),
  team_id text not null references teams(id),  -- the fixture side the stat was listed under, never the player's current team
  event match_event_type not null,
  count int not null check (count > 0),
  primary key (match_id, fpl_id, event)
);

-- ---------------------------------------------------------------- indexes

create index if not exists matches_status_kickoff_idx on matches (status, kickoff_at desc);
create index if not exists matches_home_team_idx on matches (home_team_id, kickoff_at desc);
create index if not exists matches_away_team_idx on matches (away_team_id, kickoff_at desc);
create index if not exists comments_match_perspective_idx on comments (match_id, perspective_team_id) where superseded_at is null;
create index if not exists feedback_comment_idx on feedback (comment_id);

-- ---------------------------------------------------------------- row level security

alter table teams    enable row level security;
alter table matches  enable row level security;
alter table comments enable row level security;
alter table feedback enable row level security;
alter table sessions enable row level security;
alter table players  enable row level security;
alter table match_events enable row level security;
-- players and match_events have no anon policy, so anon is refused even before the grants below.

drop policy if exists "anon can read teams" on teams;
create policy "anon can read teams" on teams for select to anon using (true);

drop policy if exists "anon can read matches" on matches;
create policy "anon can read matches" on matches for select to anon using (true);

drop policy if exists "anon can read comments" on comments;
create policy "anon can read comments" on comments for select to anon using (true);

drop policy if exists "anon can insert feedback" on feedback;
create policy "anon can insert feedback" on feedback for insert to anon with check (true);

drop policy if exists "anon can insert sessions" on sessions;
create policy "anon can insert sessions" on sessions for insert to anon with check (true);

-- ---------------------------------------------------------------- grants
-- Start from nothing for the client-facing roles, then grant exactly what the
-- policies above allow. Without these GRANTs the policies are never reached:
-- PostgREST returns "permission denied" before RLS is evaluated.

grant usage on schema public to anon, service_role;

revoke all on teams, matches, comments, feedback, sessions, players, match_events from anon, authenticated;

grant select on teams, matches, comments to anon;
grant insert on feedback, sessions to anon;
-- No SELECT on feedback/sessions for anon, so frontend inserts must use
-- "Prefer: return=minimal" (the PostgREST default), not return=representation.

grant select, insert, update, delete on teams, matches, comments, feedback, sessions, players, match_events to service_role;

-- Make the Data API pick up the new tables immediately.
notify pgrst, 'reload schema';

commit;
