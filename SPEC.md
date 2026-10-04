# Matchday Briefing — Prototype Spec (P0–P5)

Status: P0 built and passing `check-p0.js` (4 Oct 2026). P1 built on branch `p1-generation-pipeline` and passing `check-p1.js` on all four finished matchday-5 matches (4 Oct 2026), not yet merged to `main`. P2–P5 not started. This document is the build reference for the prototype described in `docs/matchday-briefing-design-doc.md` §10, revised per the interview recorded below, revised again on 22 Sep 2026 after a pre-build review (see "Revision 2" in §0), and again on 4 Oct 2026 during the P0 and P1 builds (see "Revision 3" and "Revision 4" in §0).

## How this document is used

Product/strategy conversation happens in the Claude app (a Project built on this repo's `.md` files); implementation happens in Claude Code. The two don't share chat history, so **this file is the handoff point between them, not the transcript of either conversation.**

- A decision reached in an app conversation isn't "real" for build purposes until it's written back into this file (by editing it directly, or by bringing the decision to a Claude Code session and asking for the update).
- Claude Code always builds from whatever this file currently says — never from memory of a past conversation on either side.
- Keep `docs/matchday-briefing-design-doc.md` and `interview-prompt.md` alongside it as background/history; this file is what supersedes them where they conflict (see §0).

## 0. What changed from the design doc, and why

The design doc's "safe to say" rule was a single flat standard applied to every line: every claim must be verifiable, no opinion stated as fact. Building against that rule produces a feed that reads like a hedged stats sheet, not something a real person would say at the pub. The interview revised this into a **type-specific rule**: factual lines stay strictly grounded, but the feed now also carries generic banter and strong personal opinions, gated by a narrower guardrail that targets defamation-adjacent claims specifically rather than opinion strength in general. See §3 for the rule itself.

`docs/generation-prompt-draft-v1.md`, referenced by the original interview brief, does not exist in this repository. This spec's prompt drafts (§3.4) are written fresh against the design doc and the interview decisions below, not adapted from a prior draft.

Everything in the design doc's "already decided" set is unchanged: web-first, batched-per-match generation cached and never regenerated per user, a strong model for judgment work and a cheap model only for mechanical preprocessing, ads (not subscriptions) deferred entirely out of this build, no quiz features, GitHub Pages as host, and the P0–P5 phase structure.

**Platform decision:** the frontend ships as a **Progressive Web App**, not a plain web page. It's still one static site on GitHub Pages, opened from a plain link, but it also carries a web app manifest and a service worker, so testers can install it to their home screen and cached briefings load offline. This is a small addition to "web-first", not a reversal of it. It keeps every later platform step (a Play Store listing, then a native shell) a matter of wrapping this code rather than rewriting it. The staged route, and what has to be true before each step is taken, is in §10.

**Cost note:** generating a separate comment set per team's perspective (§2) doubles LLM calls per match versus the design doc's single-batch estimate. Still trivial in absolute terms (roughly £50–60/season instead of £25–30 at the design doc's assumptions) and still one batch per match, cached — it doesn't reintroduce per-user generation cost.

### Revision 2 (22 Sep 2026, pre-build review)

A review before any code was written found gaps that would either break the build or undermine "safe to say". Fixed in this revision:

1. **Match data is thinner than the prompts assumed.** football-data.org's free tier returns no goal scorers, goal minutes, bookings, lineups or substitutions. `STAT` lines are now limited to the fields actually stored plus a fixed set of derived fields (§3.5), and the prompt's example `STAT` line no longer relies on goal times.
2. **The frontend no longer calls football-data.org.** Doing so would have exposed the API key in public code and shared its 10-requests-per-minute limit across every tester. The pipeline now writes a persisted `teams` table (§2), refreshed every run, and the frontend reads it from Supabase.
3. **API match statuses are mapped explicitly** (§2.2). The old three-value enum would have rejected real statuses such as in-play matches.
4. **Generation retries are capped** (§3.1). Previously a perspective stuck below `MIN_PASSING_COUNT` would have been regenerated on every future run, forever.
5. **The pipeline runs hourly** with a manual trigger (§1), instead of a fixed "kickoff + 2h15m" schedule that a cron job can't express.
6. **Team slugs are defined** (§2.1) and never change once assigned, so shared tester links keep working.
7. **Four checks are tightened** (§9) so they can actually fail: `check-p1` catches number words, `check-p2` uses a real headless browser, `check-p3` tests pipeline idempotency, and `check-p5` compares by prompt version.

**New decisions in this revision (confirm or reverse):**

- **No named individuals and no specific in-match incidents in any line** (§3.3). With no lineup, squad or event data, the model can't know who played, who is still at the club, or whether a penalty or red card happened, so any such line would be an unverifiable claim. `HOT_TAKE` lines are now about how a *team* played. This narrows the design doc's "real named players" framing for this build only; it returns once a data source with lineups and events exists (§6).
- **Score corrections supersede old comments** (§3.6). If football-data.org changes a finished match's score after comments were generated, those comments are hidden and the match is regenerated, so a stale scoreline is never shown.
- **League position, table and form are not used in lines** (§3.5). Unlike the final score, they change after later matches, so a cached line quoting them would go stale.

### Revision 3 (4 Oct 2026, P0 build)

Decisions made while building P0. Where they differ from §1, §2, §7 or §9, this note takes precedence.

1. **Full §2 schema ships in P0.** `supabase/schema.sql` creates all five tables (`teams`, `matches`, `comments`, `feedback`, `sessions`), their enums, RLS policies and GRANTs now, rather than adding `comments` in P1 and `feedback`/`sessions` in P4. Reason: P0's score-correction rule (§3.6) supersedes rows in `comments`, and the schema only has to be applied once. This is DDL only; no P1 code was written. The file is safe to re-run in the SQL Editor.
2. **Explicit GRANTs, including `service_role`.** The Supabase project has "automatically expose new tables" off and automatic RLS on, so no role gets table privileges by default. `schema.sql` therefore:
   - grants `anon` exactly what the §2 RLS policies allow: `SELECT` on `teams`/`matches`/`comments`, `INSERT` on `feedback`/`sessions`, nothing else;
   - grants `service_role` `SELECT`/`INSERT`/`UPDATE`/`DELETE` on all five tables. The secret key bypasses RLS but still needs GRANTs, or every pipeline write fails;
   - grants `authenticated` nothing (this build has no accounts).
   Because `anon` can't `SELECT` from `feedback`/`sessions`, P4's frontend inserts must use `Prefer: return=minimal`.
   The keys are Supabase's new `sb_publishable_`/`sb_secret_` keys, stored under the existing `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` names; no variable names change.
3. **`pipeline.yml` runs `fetch-matches.js` until P1.** `run-pipeline.js` is a P1 file, so the hourly/manual workflow invokes `node scripts/fetch-matches.js` for now, with the trigger block exactly as in §1. The optional `match` input is accepted but ignored until P1, which switches the job to `run-pipeline.js` and passes it on as `--match <id>`.
4. **`check-p0.js` status rule.** `SUSPENDED` and `AWARDED` are deliberately mapped to `other` (§2.2), so landing in `other` is not a failure by itself. The check fails only on an API status that isn't a key in `STATUS_MAP` at all, or on a stored `status` that doesn't equal `STATUS_MAP[api_status]`; statuses deliberately mapped to `other` are printed. `check-p0.js` also goes beyond §9 in two ways:
   - it checks every `FINISHED` match in the pipeline's full 14-day look-back (stored as `finished`, full-time and half-time scores equal to the API's), not only the last 7 days, so the check still tests real data during an international break, and says so when the 7-day window is empty;
   - it exercises the GRANTs with the publishable key: reads of `teams`/`matches`/`comments` succeed; reads of `feedback`/`sessions` and insert/update/delete on `teams`/`matches` are refused with "permission denied". Write probes target a non-existent id, so a wrong grant can't damage data.

**P0 findings (recorded per §7):** the free tier returns half-time scores (non-null for 4/4 finished matches) and matchday (non-null for 13/13 matches), so the §3.5 `half_time` and `matchday` fields will normally be populated; they stay nullable in case a match lacks them. A single 21-day `dateFrom`/`dateTo` request on the competition matches endpoint is accepted, so §1's window needs no splitting.

### Revision 4 (4 Oct 2026, P1 build)

Decisions made while building P1. Where they differ from §1, §3, §8 or §9, this note takes precedence. The §3.4 prompt text is unchanged.

1. **Models confirmed, and fixed in code.** Before any generation call, the free models-list endpoint confirmed that `claude-sonnet-5` and `claude-haiku-4-5-20251001` are both available to the project's API key. Both IDs are constants in `claude-client.js` with no env override, so a stored `prompt_version` always means the same models. `PROMPT_VERSION` doesn't include the model ID: changing `GENERATION_MODEL` alone leaves it unchanged, which P5 comparisons need to allow for.
2. **Call settings** (the spec was silent). Each call is a single user message holding the filled template, with no system prompt. It uses adaptive thinking at the model's default effort and `max_tokens` 16000. The SDK retries 408/409/429/5xx and connection errors up to 4 times with backoff before a call counts as "failed outright". There is no structured-outputs mode: the prompts ask for JSON in prose and are loaded verbatim, so replies are parsed as text, tolerating a ```` ```json ```` fence or a surrounding sentence.
3. **Templates and `PROMPT_VERSION`.** `prompts/*.md` hold the §3.4 code blocks byte-for-byte. Line endings are normalised to LF on load: this repo is checked out with CRLF on Windows (`core.autocrlf`) and LF on the Actions runner, and without normalising, the same prompt would get two versions. `PROMPT_VERSION` is the first 8 hex characters of SHA-256 over the generation prompt, a NUL byte, the checker prompt, a NUL byte, and `JSON.stringify(TARGET_MIX)`. The current value is `f9cbb96a`.
4. **`TARGET_MIX` guard.** The generation prompt states the mix in prose ("exactly 8", "2 STAT", "3 BANTER", "3 HOT_TAKE", "a list of 8"). `generate-comments.js` refuses to generate if those numbers disagree with `TARGET_MIX`. Editing one without the other therefore fails loudly, instead of changing `PROMPT_VERSION` without changing what the model is asked for.
5. **Candidate handling.**
   - `{{comment_json}}` is `{ type, text, note }`. The checker sees the note because users see it too.
   - An item with an invalid type, empty text or an empty note fails locally, without a checker call. Types are normalised for case and for spaces or hyphens versus underscores.
   - Only the first 8 well-formed items are checked. Any extra items fail as "beyond the first 8 candidates".
   - Checks run 4 at a time. After an outright failure, no new check starts, since the attempt is void.
   - Checker verdicts fail closed. A refusal, an unparseable reply, or a result other than `pass`/`fail` counts as `fail`, not as an outright failure.
   - A generation refusal or unparseable reply yields zero candidates and counts as an attempt (§3.1 step 3).
6. **Failed writes and counter safety.** If inserting an attempt's passing rows fails, it's treated like an outright model failure: the increment is undone, the run exits non-zero, and the perspective is retried next run. Attempt counters are moved with a compare-and-set (`update … where counter = n`), so an overlapping manual run and scheduled run can't claim the same attempt.
7. **Which matches a run considers.** A run without `--match` considers every stored `finished` match with a perspective under `MAX_GENERATION_ATTEMPTS`, not only matches in the 14-day fetch window. It reads live-comment counts page by page. Summary lines are printed only for matches where something was attempted. With `--match`, the match is always printed.
8. **`--dry-run`** skips the fetch, because §3.1 step 1 writes to Supabase, and reads the stored match instead. It prints its JSON on stdout and its logs on stderr, and saves the same JSON to `review/dryrun-<match id>.json`. `review/` is gitignored and is there for a human to read before lines go live. The dry run exits non-zero if any model call fails outright.
9. **Run output.**
   - `generation calls this run: N` counts generation calls only. The run also prints `safety-check calls this run: M` and `model tokens this run: X input, Y output`. Only calls that returned a response, and so were billed, are counted.
   - Each perspective is summarised as `<slug>: P/R passed (attempt n)`, where R is the number of items the model returned.
   - A second attempt in the same run appends `, then P/R passed (attempt 2)`.
   - `[W written]` is appended when duplicates or the cap dropped passing lines.
   - A perspective that wasn't attempted shows `<slug>: N stored`, plus "(attempt cap reached)" when N is under `MIN_PASSING_COUNT`.
10. **`check-p1.js` details.**
    - "Nothing is written" is checked against what only P1 writes: the `comments` row count, the newest `created_at`, and the match's two attempt counters. `matches` and `teams` aren't compared, because the hourly fetch on `main` may legitimately update them during the check.
    - The ≥4 rule counts distinct passing texts.
    - Number detection counts digit runs anywhere, so "2nd" is 2, plus the §9 number words as whole words only, so "someone" holds no "one". Hyphenated words are read separately, so "twenty-one" is 20 and 1.
    - The allowed numbers come from the stored match via `buildMatchData`, not from the dry run's own output.
    - `check-p1.js` exports `numbersIn`/`allowedNumbers` for `check-p5.js` to reuse.
11. **`kickoff_date`** uses fixed English abbreviations ("Sep"), because `Intl`'s en-GB format now prints "Sept".
12. **Workflow.**
    - `pipeline.yml` now runs `run-pipeline.js`. The match input is passed through an env var (never interpolated into the script) as `--match "<id>"`.
    - `actions/checkout` and `actions/setup-node` moved to v7. Both run on node24. Their breaking changes (fork-PR checkout blocked under `pull_request_target`/`workflow_run`; automatic caching limited to npm) don't affect this workflow.
    - `timeout-minutes` went from 15 to 30. A job killed mid-attempt leaves that attempt counted with nothing written, so it needs headroom for rate-limit backoff. Measured runs take about 40 s per match.
13. **Not built in P1:** `verify.js` and the `verify` npm script (§8). They chain `check-p2.js` and `check-p3.js`, which don't exist yet.

**P1 findings.**
- All four finished matchday-5 matches (560582, 560583, 560585, 560590) passed `check-p1.js` on their first dry run, with 7–8 of 8 candidates passing per perspective.
- Each dry run took 31–42 s and made 2 generation and 16 safety-check calls, using about 16.2k input and 4–6k output tokens. That's about US$0.08–0.09 per match at Sonnet 5's $2/$10 per MTok, or roughly $32 a season for 380 matches before retries.
- Dry-run lines are samples, not what testers will see. A real run generates afresh.

The dry runs also showed gaps for P5's prompt and rubric work. None is fixed here, because §3.4 is loaded verbatim:
- §6 bans league position, the table, form and season records from every line, but both prompts state that rule only for `STAT`. Passing `HOT_TAKE`/`BANTER` lines include "champions elect", "mid-table", "the recurring issue all season" and "not our sharpest start of the season". §3.3's own example, "worst first half I've seen from us all season", has the same tension.
- Venue names, which aren't in the match data, pass even in a `STAT` line ("Goalless at the break at the Cottage").
- The checker is inconsistent on scores in `BANTER`: it failed "put three past City" but passed "we never do a routine 1-0". `check-p1.js`'s number check covers `STAT` lines only.
- The generation prompt recommends "not at the races". The checker failed one use of it as implying lack of effort and passed two others.
- One passing `HOT_TAKE` implies a goal order the data doesn't have ("…get to 2 goals before the break while we were already up").

## 1. Architecture

```
matchday-briefing/
  SPEC.md
  package.json                  # "verify" script alias (§8); playwright as a devDependency
  .env.example                  # variable names only, no values (see "Secrets" below)
  .gitignore                    # must list .env and node_modules/
  scripts/
    lib/
      football-data-client.js   # football-data.org API wrapper (rate-limited to 10 req/min)
      supabase-client.js        # Supabase client for pipeline and check scripts (service-role key); never deployed
      claude-client.js          # Anthropic SDK wrapper, model IDs pulled from env/constants
      constants.js              # COMMENT_TYPES, STATUS_MAP, TARGET_MIX, MIN_PASSING_COUNT, MAX_COMMENTS_PER_PERSPECTIVE, MAX_GENERATION_ATTEMPTS
      match-data.js             # builds the match data JSON sent to both prompts (§3.5); also computes PROMPT_VERSION
      slug.js                   # team slug rule (§2.1)
    fetch-matches.js            # P0: upserts teams and matches, applies STATUS_MAP and score corrections
    generate-comments.js        # P1
    safety-check.js             # P1
    run-pipeline.js             # P0+P1 orchestrator, entry point for both cron and manual runs
    check-p0.js ... check-p5.js # one automated check script per phase, see §9
    verify.js                   # end-to-end runner: pipeline + check-p0 to check-p3 (§8)
  prompts/
    generation-prompt.md        # §3.4 template, loaded verbatim by generate-comments.js
    safety-checker-prompt.md    # §3.4 template, loaded verbatim by safety-check.js
  supabase/
    schema.sql                  # §2 tables + RLS policies
  frontend/
    index.html                  # links the manifest, registers sw.js
    config.js                   # SUPABASE_URL and SUPABASE_ANON_KEY only; safe to publish (see "Secrets")
    app.js                      # routing (?team=), rendering, localStorage recents + device id
    style.css
    manifest.webmanifest        # PWA manifest: name, icons, start_url, display: standalone
    sw.js                       # service worker: app-shell cache + offline fallback for briefings
    icons/                      # icon-192.png, icon-512.png, icon-maskable-512.png
  .github/workflows/
    pipeline.yml                # hourly schedule + manual trigger for run-pipeline.js
    pages.yml                   # deploys frontend/ to GitHub Pages on push to main
```

- **Frontend:** static, served from GitHub Pages. `.github/workflows/pages.yml` deploys the `frontend/` folder (`actions/upload-pages-artifact` → `actions/deploy-pages`), since branch-based Pages can only publish from the repo root or `/docs`. Deep links use `?team=<slug>` query params — GitHub Pages has no clean path-based routing without a redirect workaround, and query params need none.
- **Domain:** the site lives at **`https://didyouseethatludicrousdisplaylastnight.co.uk`**, a domain the project owner already holds. The bare domain (no `www`) is the canonical address used in every tester link and in the manifest.
  - **GitHub:** set the domain under repo Settings → Pages → Custom domain, then tick "Enforce HTTPS" once the certificate is issued. No `CNAME` file goes in `frontend/` — GitHub ignores it for Actions-based deploys.
  - **DNS, at the domain's registrar:** four `A` records on the bare domain pointing to `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153` (plus the matching `AAAA` records `2606:50c0:8000::153` to `2606:50c0:8003::153` if the registrar supports IPv6), and a `CNAME` for `www` pointing to `<github-username>.github.io`. With both in place, GitHub redirects `www.` to the bare domain automatically.
  - **Verify the domain** in GitHub account settings (Settings → Pages → Add a verified domain, via a `TXT` record). This stops anyone else's GitHub repo from claiming the domain if the Pages site is ever switched off.
  - **Do this before P2 is shared with anyone.** Installed apps, service-worker caches, `localStorage` recents and the anonymous `deviceId` are all tied to the address the site was opened on. A tester who installs from the `github.io` address and later gets moved to the domain loses their recents, has their device counted as new, and ends up with an orphaned installed app.
  - Renewal of the `.co.uk` registration sits with the project owner, outside this repo. If it lapses, every tester link and installed app breaks at once.
- **PWA layer:** GitHub Pages serves over HTTPS on custom domains too, which service workers require, so no extra hosting is needed. The site is served from the domain root, so `start_url` and `scope` in `manifest.webmanifest` are `/`. `sw.js` uses two caching rules:
  - **App shell** (`index.html`, `app.js`, `style.css`, icons): cache-first, versioned by a `CACHE_VERSION` constant that is bumped on every deploy so testers never get stuck on a stale build.
  - **Briefing data** (Supabase reads): network-first, falling back to the last cached response. An offline tester still sees the last briefing they loaded, with its date label, rather than a blank screen.
  - Feedback writes (thumbs) are never cached or queued. If the tester is offline, the tap shows a "You're offline — reaction not saved" toast.
- **Data store:** Supabase (Postgres, free tier). Frontend reads `teams`/`matches`/`comments` directly with the anon key under read-only RLS; writes to `feedback` and `sessions` under insert-only anon policies. The frontend calls Supabase's REST endpoint (`<SUPABASE_URL>/rest/v1/...`) with plain `fetch` and the anon key from `frontend/config.js`, so no client library or build step is needed. Pipeline scripts use the service-role key for all writes.
- **Pipeline runner:** `.github/workflows/pipeline.yml`, a scheduled GitHub Actions job invoking `node scripts/run-pipeline.js`. No separate server.
  - **Schedule: hourly, not tied to kickoff times.** Premier League kickoffs vary (lunchtime, 3pm, evening, midweek), a cron schedule can't follow them, and free-tier scores arrive delayed rather than live. Running every hour is safe because the pipeline only generates for `finished` matches that don't yet have a complete briefing (§3.1), so most runs make two football-data.org requests and no model calls.
  - Trigger block:
    ```yaml
    on:
      schedule:
        - cron: '15 * * * *'        # every hour at :15, UTC
      workflow_dispatch:             # "Run workflow" button in the Actions tab
        inputs:
          match:
            description: 'Optional football-data.org match id'
            required: false
    concurrency:
      group: pipeline
      cancel-in-progress: false     # never run two pipelines at once
    ```
  - The job sets `FOOTBALL_DATA_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as environment variables from the repo's Actions secrets. When the manual trigger is given a match id, the job passes it on as `--match <id>`; otherwise it runs with no arguments.
  - **Close-season caveat:** in a public repository, GitHub disables scheduled workflows after 60 days with no repository activity, and the summer break is longer than that. Before each new season starts, open the repo's Actions tab, select the pipeline workflow and re-enable it if GitHub has disabled it.
- **Match data:** football-data.org free tier, v4 API, authenticated with the `X-Auth-Token` header. Each pipeline run makes two requests: the competition teams endpoint (`/v4/competitions/PL/teams`) and the competition matches endpoint (`/v4/competitions/PL/matches`, filtered with `dateFrom`/`dateTo` to the last 14 days and the next 7). Only the pipeline calls football-data.org; the frontend never does (see "Secrets"). Team list is fetched dynamically and written to the `teams` table every run — never hardcoded — so it stays correct across season changes. Team crests are not fetched or displayed; they carry separate copyright terms not covered by the data API license. Attribution ("Match data via football-data.org") goes in `frontend/index.html`'s footer. The free tier's non-commercial-use term is compatible with this build only because it carries no ads; **this must be revisited before V1 turns on monetisation**.
  - **What the free tier does not return:** goal scorers, goal minutes, assists, bookings, lineups, substitutions, and match statistics (possession, shots and so on). Nothing in this build may depend on them; §3.5 lists exactly what generation can use.
- **Secrets and config:** five values, named in `.env.example` without values:
  - `FOOTBALL_DATA_API_KEY`, `ANTHROPIC_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are secret. They live only in a local `.env` file (listed in `.gitignore`, never committed) and in the repo's GitHub Actions secrets (Settings → Secrets and variables → Actions). They must never appear anywhere under `frontend/`, in any commit, or in a chat.
  - `SUPABASE_URL` and `SUPABASE_ANON_KEY` are public by design: the anon key can only do what the RLS policies in §2 allow. They are committed in `frontend/config.js` and also set in `.env` for the pipeline and check scripts.
  - `check-p2.js` (§9) fails if any secret value appears in the deployed frontend.
- **Models:** `claude-client.js` exposes `GENERATION_MODEL = "claude-sonnet-5"` (used for both `generate-comments.js` and `safety-check.js`, since checking is a judgment task, not mechanical preprocessing) and `MECHANICAL_MODEL = "claude-haiku-4-5-20251001"` (used only for cleaning/dedupe/format steps inside `fetch-matches.js`, if any are needed).

## 2. Data shapes (`supabase/schema.sql`)

```sql
create type match_status as enum ('scheduled', 'in_play', 'finished', 'postponed', 'cancelled', 'other');
-- API statuses are mapped into these by STATUS_MAP (§2.2); only 'finished' is eligible for generation
create type comment_type as enum ('STAT', 'BANTER', 'HOT_TAKE');
create type checker_status as enum ('passed');
-- only passed rows are ever written; failed candidates are logged to stdout in the pipeline run, not persisted

create table teams (
  id text primary key,                -- football-data.org team id
  name text not null,                 -- full name as the API returns it
  short_name text not null,           -- API shortName; shown in the picker and on match cards
  tla text not null,                  -- API three-letter code, e.g. 'ARS'
  slug text not null unique,          -- §2.1; assigned once on insert, never changed
  in_current_season boolean not null, -- true if in the latest competition-teams response
  updated_at timestamptz not null
);

create table matches (
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

create table comments (
  id uuid primary key default gen_random_uuid(),
  match_id text not null references matches(id),
  perspective_team_id text not null references teams(id),  -- which team's fans this line is framed for
  type comment_type not null,
  text text not null,
  note text not null,                 -- type-tailored explanation shown under the line
  checker_status checker_status not null default 'passed',
  prompt_version text not null,       -- PROMPT_VERSION at generation time (§3.5); lets P5 compare reactions by prompt
  superseded_at timestamptz,          -- set when a score correction invalidates the line (§3.6); frontend shows only null rows
  created_at timestamptz not null default now()
);

create table feedback (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references comments(id),
  device_id uuid not null,            -- anonymous, generated client-side, stored in localStorage
  reaction text not null check (reaction in ('up', 'down')),
  created_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null,            -- same anonymous id as feedback
  installed boolean not null,         -- true when running as an installed PWA (display-mode: standalone)
  created_at timestamptz not null default now()
);

-- RLS: anon key can select from teams/matches/comments, insert-only on feedback and sessions; no anon update/delete anywhere.
```

`teams` is persisted, but it can't drift: `fetch-matches.js` upserts every team from the competition-teams endpoint on every run, sets `in_current_season = true` for those teams and `false` for any other row. Relegated teams keep their rows (older matches still reference them) but drop out of the picker. The frontend reads team names from this table and never calls football-data.org itself.

### 2.1 Team slug rule (`scripts/lib/slug.js`)

Slugs are the `?team=` value in every tester link, so they must be predictable and permanent.

- Built from `short_name`: lower-case it, strip accents, replace `&` with `and`, replace every run of characters other than `a–z` and `0–9` with a single hyphen, and trim hyphens from both ends. For example, a short name of `Man United` becomes `man-united`, and `Arsenal` becomes `arsenal`.
- If the result is already taken by a different team id, append `-` plus the lower-cased `tla`.
- A slug is assigned only when the team's row is first inserted and is never changed afterwards, even if the API later changes the short name. Links already shared keep working.
- The frontend resolves `?team=<slug>` by looking the slug up in `teams`. An unknown slug shows "We don't know that team" above the normal team picker, never a blank page.

### 2.2 Match status mapping (`STATUS_MAP` in `scripts/lib/constants.js`)

football-data.org reports more statuses than the app needs. `fetch-matches.js` stores the raw value in `api_status` and the mapped value in `status`:

| API status | Stored `status` | Generation? |
|---|---|---|
| `SCHEDULED`, `TIMED` | `scheduled` | No |
| `IN_PLAY`, `PAUSED`, `EXTRA_TIME`, `PENALTY_SHOOTOUT` | `in_play` | No |
| `FINISHED` | `finished` | Yes |
| `POSTPONED` | `postponed` | No |
| `CANCELLED` | `cancelled` | No |
| `SUSPENDED`, `AWARDED`, or any value not listed here | `other` | No |

Any status that falls through to `other` is also logged as a warning, so a new or unexpected API value is noticed rather than silently dropped.

## 3. Generation pipeline (P1)

### 3.1 Trigger and flow (`run-pipeline.js`)

Constants (in `scripts/lib/constants.js`): `MIN_PASSING_COUNT = 4`, `MAX_COMMENTS_PER_PERSPECTIVE = 8`, `MAX_GENERATION_ATTEMPTS = 2`.

1. `fetch-matches.js` upserts `teams`, then upserts the fetched matches into `matches`, mapping statuses with `STATUS_MAP` (§2.2) and applying the score-correction rule (§3.6). Only `finished` matches are eligible for generation; everything else is written with its mapped status and left alone. A match not yet finished when the job runs is simply picked up on a later hourly run — never generated from incomplete data.
2. For each `finished` match, each perspective (home team, away team) is handled separately. A perspective is **eligible** only if both are true:
   - it has fewer than `MIN_PASSING_COUNT` live comments (rows with `superseded_at` null), and
   - its attempt counter (`home_generation_attempts` or `away_generation_attempts`) is below `MAX_GENERATION_ATTEMPTS`.
3. For each eligible perspective, increment its attempt counter, then call generation once. The counter counts any attempt where the model returned a response, including an unparseable one (which yields zero candidates). If any model call in the attempt fails outright (generation or a safety check: network error, rate limit, outage), write nothing for that attempt, undo the increment, log the error, move on, and make the run exit non-zero so the failure shows red in the Actions tab. The perspective is retried on the next hourly run.
4. Each candidate goes through `safety-check.js`. Once every candidate in the attempt has been checked, each passing candidate is written to `comments` with the current `PROMPT_VERSION`, unless:
   - its text matches an existing live comment for that perspective (case-insensitive, whitespace-trimmed), in which case it's dropped as a duplicate, or
   - the perspective already has `MAX_COMMENTS_PER_PERSPECTIVE` live comments.

   Failing candidates are logged with their failure reason and dropped.
5. After the attempt, if the perspective is still below `MIN_PASSING_COUNT` and under `MAX_GENERATION_ATTEMPTS`, it's retried straight away in the same run. Once the cap is reached, whatever passed is accepted, and the perspective is never generated again unless a score correction (§3.6) resets its counter. This is what keeps "generate once, cache" true: a perspective that stays below 4 does not get regenerated every hour.
6. The run ends by printing one summary line per match it touched, e.g. `2026-09-19 ARS v TOT — arsenal: 7/8 passed (attempt 1), tottenham: 8/8 passed (attempt 1)`, followed by `generation calls this run: N`.

Command-line options for `run-pipeline.js`:
- `--match <id>` limits the run to one match. Normal eligibility rules still apply, so a match with a complete briefing is not regenerated; its stored counts are printed instead.
- `--dry-run` must be combined with `--match <id>` and the match must be `finished`. It ignores eligibility, runs one generation attempt per perspective plus safety checking, and prints every candidate with its pass/fail result as JSON. It writes nothing to Supabase and doesn't touch attempt counters. Checks `check-p1.js` and `check-p5.js` use this so they never alter what testers see.

### 3.2 Target composition

Per perspective, per match: **8 comments — 2 `STAT` / 3 `BANTER` / 3 `HOT_TAKE`**. This is a target passed to the generation prompt, not a guarantee — the safety checker may unevenly fail one type more than another, and the pipeline does not enforce per-type minimums, only the overall `MIN_PASSING_COUNT = 4`.

### 3.3 Safety rule, by type

- **Every type:**
  - **No named individuals.** No player, manager, coach, referee or other official may be named or clearly identified, including through stand-ins like "their keeper" or "the new signing". There is no lineup or squad data, so the model can't know who played or who is still at the club, and its training knowledge of squads goes out of date with every transfer window.
  - **No specific in-match incidents** that aren't in the match data (§3.5): goals by minute or scorer, penalties, red or yellow cards, VAR decisions, saves, injuries, substitutions. The free tier doesn't report them, so any such claim is invented.
  - **No contradicting the match data**, even in an opinion. A line calling a first half poor when the team led 2-0 at the break fails.
- **`STAT`** — every specific claim must trace to a field in the match data JSON (§3.5): the final score, the half-time score if present, the result, points, clean sheet, home/away, matchday or kickoff date. Checker fails it if any claim isn't in the data, even if the claim might be true (a scorer's name, a league position). `note` names what grounds it, e.g. "From the official final score."
- **`HOT_TAKE`** — a strong, explicitly-opinion-framed take about how a **team** played, as a whole.
  - Positive/enthusiastic: unrestricted, however strong.
  - Negative/critical: allowed to be equally strong on **performance**, but the checker fails any line — regardless of how it's hedged or phrased as opinion — that implies the team, its players or staff lacked effort, were dishonest or cheated, or refers to anything off the pitch. "Worst first half I've seen from us all season" passes (provided the half-time score doesn't contradict it); "they couldn't be bothered" fails.
  - `note`: an outlier warning, e.g. "Strong take — not everyone will agree."
- **`BANTER`** — generic, team/rivalry-flavoured, not tied to this match's specific data. Must not state a specific date, score, or named past incident, since there is no historical data source to verify such a claim against yet (this is exactly the "invented fact" risk called out in the interview). `note`: "General chat, not a specific claim."
  - Parked, not in this build: a historical head-to-head data source, so `BANTER` can eventually make verified specific callbacks.
  - Parked, not in this build: a lineup and match-events data source, so lines can eventually name players and refer to real incidents.

No `verified`/`provisional` confidence flag in this build — the design doc's version of that flag targeted mid-match data uncertainty, and this pipeline only ever generates from `finished` matches, so there's nothing for it to distinguish. Revisit if a future phase adds pre-match or live content.

### 3.4 Prompt drafts

**`prompts/generation-prompt.md`** (templated, filled per call):

```
You are writing conversational talking points for a football fan about a match
their team just played, so they can hold their own in casual chat without
having watched it. Write from the perspective of a {{perspective_team_name}}
fan reacting to this result.

Match data:
{{match_data_json}}

The match data above is everything that is known about this match. There
is no information about who played, who scored, when goals went in, cards,
penalties, substitutions or any other incident. If a field is null, that
fact is unknown: don't mention it.

Rules for every comment:
- Never name or clearly identify any individual: no players, managers,
  coaches or officials, and no stand-ins like "their keeper" or "the new
  signing".
- Never describe a specific incident that isn't in the match data (a goal
  by a particular player or at a particular time, a penalty, a card, a VAR
  call, a save, an injury).
- Never contradict the match data, even in an opinion.

Write exactly 8 comments in this mix:
- 2 STAT: a short line whose every specific claim is drawn directly from
  the match data above (final score, half-time score if present, result,
  points, clean sheet, home or away, matchday, date). Nothing else — no
  league position, no form, no season records.
- 3 BANTER: generic, team/rivalry-flavoured chat that does NOT reference this
  match's specific events and does NOT state any specific date, score, or named
  past incident (you have no way to verify those, so don't invent them).
- 3 HOT_TAKE: a strong, clearly-opinion-framed take about how a team played,
  as a whole. Positive takes can be as enthusiastic as you like. Negative
  takes can be just as strong about PERFORMANCE ("worst first half I've seen
  from us all season", if the half-time score allows it) but must never imply
  the team, its players or staff didn't try, were dishonest, cheated, or say
  anything about life off the pitch — even hedged as opinion.

Voice reference — real patterns pulled from how pundits and fans actually
talk (Match of the Day analysis, phone-in shows, live text commentary),
not polished prose:
- Hedge openers before an opinion: "For me,", "If I'm being honest,",
  "I'll be honest,", "Say what you like, but".
- Real idiom, used sparingly and only where it fits: "put in a shift",
  "game management", "backs against the wall", "second best all over the
  pitch", "job done", "not at the races", "a game of two halves".
- Clipped, spoken rhythm over tidy essay sentences — short clauses, the
  odd sentence fragment, dashes instead of semicolons.
- STAT lines read like a live-text snippet (terse, present-feeling: "Two
  up at the break, 3-1 at the end — job done", when the half-time and
  full-time scores say so), not a press-release summary.
Avoid: stacking more than one idiom per line, and any phrase so generic
it could apply to literally any match (that's the AI-generic failure
mode this voice reference exists to prevent).

For each comment, also write a one-sentence "note":
- STAT: name the data field it's grounded in.
- BANTER: say plainly it's general chat, not a specific claim.
- HOT_TAKE: flag it as a strong take other fans might disagree with.

Return JSON: a list of 8 objects, each { "type", "text", "note" }.
```

**`prompts/safety-checker-prompt.md`**:

```
You are checking one football comment against a match's real data before it
ships to a user. Reject anything that could embarrass the user if challenged,
using the rule for its declared type.

Match data:
{{match_data_json}}

Comment to check:
{{comment_json}}

The match data above is everything that is known about this match. It has
no information about who played, who scored, goal times, cards, penalties,
substitutions or any other incident.

Rules for every type — fail the comment if it:
- names or clearly identifies any individual (player, manager, coach,
  official), including stand-ins like "their keeper" or "the new signing";
- describes a specific incident that isn't in the match data (a goal by a
  particular player or at a particular time, a penalty, a card, a VAR call,
  a save, an injury);
- contradicts the match data, even as an opinion.

Rules by type:
- STAT: every specific claim must appear in the match data above. Fail if
  any claim isn't in the data, even if it might be true (a scorer, a league
  position, a run of form).
- HOT_TAKE: positive/enthusiastic opinions pass, however strong, provided
  they meet the rules for every type. For negative/critical opinions, also
  fail if it implies (in any phrasing, including hedged as opinion) that
  the team, its players or staff lacked effort, were dishonest or cheated,
  or references anything off the pitch. Strong performance criticism alone
  is not a failure.
- BANTER: fail if it states a specific date, score, or named past incident,
  since none of that can be verified against real data.

Return JSON: { "result": "pass" | "fail", "reason": "<why, if failed>" }.
```

### 3.5 Match data sent to the model (`scripts/lib/match-data.js`)

`buildMatchData(match, perspectiveTeam, opponentTeam)` produces the `{{match_data_json}}` value for both prompts, so the generator and the checker always see identical facts. Every field is either stored in `matches`/`teams` or computed deterministically from stored fields; nothing else is ever added. Example, from Arsenal's perspective:

```json
{
  "competition": "Premier League",
  "matchday": 5,
  "kickoff_date": "Sat 19 Sep 2026",
  "perspective_team": "Arsenal",
  "opponent": "Tottenham",
  "perspective_side": "home",
  "full_time": { "perspective": 3, "opponent": 1 },
  "half_time": { "perspective": 2, "opponent": 0 },
  "result": "won",
  "points_earned": 3,
  "clean_sheet": false,
  "total_goals": 4,
  "winning_margin": 2,
  "half_time_state": "leading",
  "half_time_comeback": false
}
```

- Team names are `teams.short_name`.
- `kickoff_date` is formatted in the Europe/London timezone.
- `result` is `won`, `drew` or `lost`; `points_earned` is 3, 1 or 0; `winning_margin` is the absolute goal difference (0 for a draw).
- `half_time`, `half_time_state` (`leading`, `level` or `trailing`) and `half_time_comeback` (trailed at half time and didn't lose) are `null` when the half-time score isn't stored. `matchday` is `null` when the API didn't provide it.
- **Deliberately excluded:** league position, the table, form and season records. They change after later matches, so a cached line quoting them would go stale.

`PROMPT_VERSION` is also computed here: the first 8 characters of a SHA-256 hash of `prompts/generation-prompt.md`, `prompts/safety-checker-prompt.md` and `TARGET_MIX` together. It changes automatically whenever a prompt or the mix is edited, so there's nothing to remember to bump. Every written comment records it.

### 3.6 Score corrections

If `fetch-matches.js` finds that a match already stored as `finished` now has a different full-time or half-time score from the API:

1. Update the scores.
2. Set `superseded_at = now()` on every live comment for that match (both perspectives). Rows are kept, not deleted, so their `feedback` survives.
3. Reset `home_generation_attempts` and `away_generation_attempts` to 0, so the next step of the same run regenerates both perspectives.
4. Log `SCORE CORRECTED: <match id> <old score> -> <new score>` as a warning.

The frontend only ever shows comments with `superseded_at` null, so a line quoting the old score is never shown again.

## 4. Frontend (P2)

- **`frontend/index.html` (homepage):** a text list of the current Premier League teams (read at page load from the Supabase `teams` table where `in_current_season` is true, sorted by `short_name`; never hardcoded and never fetched from football-data.org) as the picker, plus a "Recent" list read from `localStorage` (`recentTeams`, an array of slugs, most-recent-first, capped at a handful). Picking a team, or loading a `?team=` link directly, adds that team to `recentTeams` and navigates to the team view.
- **Team view:** loads that team's most recent `finished` match that has live comments (`superseded_at` null) for that team's perspective, from Supabase. If the team's true next fixture hasn't been played yet or is in progress, this is still their most recent *finished* match — shown with an explicit date label (e.g. "Last match: Sat 13 Sep") so it's never mistaken for a live game. Team names on the match card come from `teams.short_name`.
  - **No briefing yet** (for example at the very start of the season, or before the pipeline's first run): show "No briefing yet for <team> — check back after their next match" instead of a blank page.
  - **Unknown `?team=` slug:** show "We don't know that team" above the normal picker (§2.1).
- **Comment card:** comment `text`, a visible type tag (`STAT` / `BANTER` / `HOT TAKE`), the `note`, a copy-to-clipboard button, and thumbs up/down. A thumbs click writes a row to `feedback` tagged with a `deviceId` (a UUID generated once and cached in `localStorage`, no accounts).
  - Comment `text` and `note` are model output, so `app.js` inserts them with `textContent`, never `innerHTML`. A stray `<` or `&` in a generated line must render as text, not break the page.
- **Existing mock-up:** the look-and-feel prototype published earlier on claude.ai is a visual reference only. Its sample lines include scorers, specific incidents and match-specific banter that §3.3 now forbids, so don't copy its content or show it to testers as representative of real output.
- No ad space is reserved anywhere in this layout; ad placement is designed when V1 actually implements ads.
- **Install:** on Android/Chrome, the browser's own "Install app" prompt is enough — no custom install banner in this build. The homepage footer carries one line of help for iOS testers ("On iPhone: Share → Add to Home Screen"), since iOS has no install prompt.
- **Installed look:** `display: standalone`, theme and background colours taken from the frontend's own palette tokens, app name "Matchday Briefing", short name "Matchday". Icons are the app's own mark — no club crests or colours, same licensing rule as the picker.

## 5. Testers (P4)

- Thumbs reactions land in `feedback` in real time, queryable per comment.
- `frontend/index.html` links to an external form (e.g. a Google Form the user sets up separately) for open-ended feedback.
- What round 1 is testing, per the design doc's P4 goal extended for the revised mix: does a line feel safe to say, does it feel natural, would the tester actually use it, and does the STAT/BANTER/HOT_TAKE mix feel right or lopsided.
- **Platform questions (these decide the next platform step, see §10):** the external form also asks (1) did you install it to your home screen, (2) would you want a notification when your team's briefing is ready, and (3) would you look for it in the Play Store. `app.js` also logs whether each session is running installed (`display-mode: standalone`) to a `sessions` count alongside feedback, so the install rate is measured, not just self-reported.

## 6. Out of scope for this build (P0–P5)

- Accounts/login (device-local identifier only, via `localStorage`)
- Save/favourite lines, topic tracking
- Rivalry/context flags, pre-match content, player-of-match blurb, historical hooks (V1 proper)
- Ads/monetisation, including reserved layout space
- Tone picker, difficulty levels, push notifications, widgets, share-sheet integration (V2/V3). The PWA makes web push possible later, but no push is built in P0–P5.
- A Play Store listing (Trusted Web Activity wrap) and a Capacitor native shell. Both are later, gated steps (§10), not part of this build.
- A custom install banner. The browser's own prompt is enough for testers.
- Multi-sport (V4)
- Quiz/knowledge-testing (cut permanently, per design doc)
- Verified historical `BANTER` callbacks (parked — needs a future historical data source)
- Named players, managers or officials, and specific in-match incidents (goals by scorer or minute, penalties, cards, VAR), in any line type (parked — needs a lineup and match-events data source; see §3.3)
- League position, table, form or season records in any line (they go stale once cached; see §3.5)
- Any football-data.org call from the frontend (the pipeline is the only caller; see §1)
- Confidence flag (`verified`/`provisional`) — deliberately dropped for this build, see §3.3

## 7. Phase mapping

| Phase | Scope | Files | Runnable output |
|---|---|---|---|
| **P0 — Data pipeline** | `football-data-client.js`, `fetch-matches.js`, `teams` and `matches` tables, status mapping, slug rule, score corrections, hourly schedule, secrets setup | `scripts/lib/football-data-client.js`, `scripts/lib/constants.js`, `scripts/lib/slug.js`, `scripts/fetch-matches.js`, `supabase/schema.sql`, `.github/workflows/pipeline.yml`, `.env.example`, `.gitignore` | `node scripts/fetch-matches.js` populates `teams` (20 current-season rows, each with a slug) and `matches` with real, current PL results; P0 also records whether the free tier returns half-time scores and matchday |
| **P1 — Generation pipeline** | `generate-comments.js`, `safety-check.js`, prompts, match data builder, retry cap, `--match`/`--dry-run`, `run-pipeline.js` | `scripts/lib/match-data.js`, `scripts/lib/claude-client.js`, `scripts/generate-comments.js`, `scripts/safety-check.js`, `prompts/*.md`, `scripts/run-pipeline.js` | `node scripts/run-pipeline.js --match <id>` produces passing, tagged, noted rows in `comments` for both perspectives, each carrying a `prompt_version` |
| **P2 — Minimal frontend (PWA)** | Homepage, team view, comment cards, empty states, routing, manifest, service worker, Pages deploy on the custom domain | `frontend/index.html`, `frontend/config.js`, `frontend/app.js`, `frontend/style.css`, `frontend/manifest.webmanifest`, `frontend/sw.js`, `frontend/icons/`, `.github/workflows/pages.yml` | Open `https://didyouseethatludicrousdisplaylastnight.co.uk`, pick a team, read and copy real comments; install it to an Android home screen and reopen the last briefing with the network off |
| **P3 — Connect and cache** | Wire frontend to live Supabase reads; confirm no regeneration on repeat views or repeat pipeline runs | (no new files — integration of P1+P2 outputs) | Two different browsers loading the same `?team=` see identical comments, and running the pipeline a second time makes no generation calls and adds no `comments` rows |
| **P4 — Tester round 1** | Thumbs writes, session logging, external form link (including the platform questions in §5) | `frontend/app.js` (feedback + session writes), `supabase/schema.sql` (`feedback`, `sessions` tables) | Real rows in `feedback` and `sessions`, plus external-form responses that answer the §10 platform gate |
| **P5 — Iterate** | Adjust `prompts/*.md` / mix / rubric from P4 data | `prompts/*.md`, `scripts/lib/constants.js` | After a prompt edit, `node scripts/run-pipeline.js --match <id> --dry-run` shows candidates under a new `prompt_version`, and `check-p5.js` prints the thumbs-up rate per `prompt_version` so old and new prompts can be compared on real tester reactions |

## 8. End-to-end verification

One command proves the whole automated path works:

```
node scripts/verify.js --match <finished-match-id>
```

`scripts/verify.js` runs, in order and stopping at the first failure: `node scripts/run-pipeline.js --match <id>`, then `check-p0.js`, `check-p1.js --match <id>`, `check-p2.js` and `check-p3.js --match <id>`. `package.json` also exposes it as `npm run verify`. It needs a filled-in `.env` and a one-off `npx playwright install chromium`. `check-p4.js` and `check-p5.js` are not included, because they depend on real testers and on a prompt edit respectively.

Then open, in Chrome:

```
https://didyouseethatludicrousdisplaylastnight.co.uk/?team=<slug of either team in that match>
```

**Passing output:**
- The pipeline prints its per-match summary line, e.g. `2026-09-19 ARS v TOT — arsenal: 7/8 passed (attempt 1), tottenham: 8/8 passed (attempt 1)`, then `generation calls this run: N`. On a match that already has a complete briefing it prints the stored counts and `generation calls this run: 0`.
- Each check prints `PASS check-pN: <one-line reason>`, and the command ends with `verify: all checks passed` and exit code `0`. Any failure prints `FAIL check-pN: <reason>` and exits non-zero.
- Supabase `comments` has live rows (`superseded_at` null) for that `match_id` for both perspective teams, each with a valid `type`, a non-empty `note`, `checker_status = 'passed'` and a `prompt_version`.
- The deployed page for that team renders the match's date label, at least 4 tagged comment cards, and each card's copy button and thumbs buttons work with no console error.
- Chrome DevTools → Application shows the manifest parsed with no errors and `sw.js` activated. With DevTools' network set to Offline, reloading the same `?team=` link still shows the same briefing.

## 9. Checks (one automated check per phase, for self-verification without the user watching)

Every check prints `PASS check-pN: <reason>` or `FAIL check-pN: <reason>` and exits `0` or non-zero accordingly. Checks read secrets from `.env` and never print them.

- **`scripts/check-p0.js`:**
  - Every PL match with API status `FINISHED` in the last 7 days (per the live API) has a `matches` row with `status = 'finished'` and non-null `home_score`/`away_score`.
  - `teams` has exactly 20 rows with `in_current_season = true`, every slug is non-empty and matches the §2.1 pattern, and no two slugs are equal.
  - Every `api_status` value seen in the last 7 days maps through `STATUS_MAP`; the check prints any value that fell through to `other`.
  - Prints whether half-time scores and matchday came back non-null, so the §3.5 assumptions are confirmed rather than guessed.
- **`scripts/check-p1.js --match <id>`:** runs `run-pipeline.js --match <id> --dry-run` against a known finished match and asserts:
  - both perspectives have at least 4 passing candidates;
  - every `type` is one of the three valid enum values and every `note` is non-empty;
  - **number check:** every number in a passing `STAT` line's text is in the allowed set built from that perspective's match data (full-time and half-time scores, `total_goals`, `winning_margin`, `points_earned`, `matchday`, and the day and year in `kickoff_date`). Numbers are detected both as digits and as number words: `nil`, `zero` and `one` to `twenty`, including hyphenated forms such as `three-one`.
  - Nothing is written to Supabase.
- **`scripts/check-p2.js`:**
  - `https://didyouseethatludicrousdisplaylastnight.co.uk/` returns 200 over HTTPS, and the `http://` and `www.` versions both redirect to it.
  - Using Playwright with headless Chromium (a plain HTTP fetch can't see what `app.js` renders): the homepage shows one picker entry per current-season row in `teams`, and loading `?team=<slug>` for every one of those slugs renders either at least one comment card or the "No briefing yet" message — never a blank page, an error state, or a browser console error. `?team=not-a-real-team` renders "We don't know that team".
  - `manifest.webmanifest` has `name`, `start_url`, `display: "standalone"` and 192px + 512px icons that return HTTP 200, and `sw.js` returns 200 with a JavaScript content type.
  - **Secrets check:** fetches every deployed file under `frontend/` (HTML, JS, CSS, manifest) and fails if the value of `FOOTBALL_DATA_API_KEY`, `ANTHROPIC_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` appears in any of them.
- **`scripts/check-p3.js --match <id>`:**
  - **Pipeline idempotency:** records the number of `comments` rows for the match, runs `run-pipeline.js --match <id>` again, and asserts the run reported `generation calls this run: 0` and the row count is unchanged.
  - **Shared cache:** loads the same `?team=` URL in two separate Playwright browser contexts (no shared storage) and asserts both show the same comment ids in the same order.
- **`scripts/check-p4.js`:** queries `feedback` and `sessions` and asserts at least one row exists in each, confirming the thumbs and session-logging paths work end-to-end from a real browser. It also prints the installed-session rate (share of `sessions` rows with `installed = true`), which is the §10 gate number.
- **`scripts/check-p5.js --match <id>`:** run after editing a prompt or `TARGET_MIX`. It asserts:
  - the current `PROMPT_VERSION` differs from the `prompt_version` on that match's stored comments, proving the edit was picked up;
  - a dry run under the new version passes every `check-p1.js` assertion, so the edit didn't break safety.

  It then prints the thumbs-up rate and comment count per `prompt_version` across all of `feedback`, which is how old and new prompts are compared on real tester reactions. (The old version of this check asserted only that output differed, which it always does, so it could never fail.)

## 10. Platform path after P5

The backend (pipeline, Supabase, prompts) is the same at every step below. Only the frontend shell changes, and each step wraps the code from the step before it instead of replacing it. None of these steps is part of P0–P5; each one waits for its gate.

| Step | What it is | Gate: take this step only when… | Cost | Reuses |
|---|---|---|---|---|
| **1. PWA** (this build) | Web page + manifest + service worker on GitHub Pages | — (built in P2) | Free | — |
| **2. Play Store listing** | Wrap the PWA as a Trusted Web Activity with Bubblewrap or PWABuilder | P4 shows people actually want it as an app: at least ~30% of tester sessions run installed, **or** most testers say they'd look for it in the Play Store | $25 one-off Google developer fee | All of step 1 unchanged; website updates reach the app instantly |
| **3. Native shell** | Put the same web code inside Capacitor to reach native features | V3 features are actually scheduled: home-screen widget, lock-screen card, native share sheet, or push that must also work reliably on iOS | Android Studio/Xcode builds; +$99/yr if iOS ships | All of step 1's HTML/JS; only the widget itself needs native Kotlin/Swift |
| **4. Full native rewrite** | React Native, Flutter, or Kotlin/Swift | Capacitor has been tried and can't deliver a required feature or performance level | A full frontend rewrite | Backend only |

Notes that apply before each step:
- **Before step 2:** the Play Store wrap proves the app owns the site with a Digital Asset Links file at `https://didyouseethatludicrousdisplaylastnight.co.uk/.well-known/assetlinks.json`, so it goes in `frontend/.well-known/`. The Actions deploy doesn't run Jekyll, so the dot-folder is published as-is. Also check Google Play's current policy on showing web ads inside a Trusted Web Activity before V1 turns ads on. Don't assume it's allowed. Also re-check the football-data.org commercial-use term (§1) at the same time, since a store listing plus ads is clearly commercial use.
- **Before step 3:** web push (possible from step 1 onward) may cover the "your briefing is ready" notification on Android well enough that step 3 isn't needed for push alone. Test that before choosing Capacitor for push.
- The ~30% install threshold is a starting default, not a researched figure. Change it here if P4 suggests a better bar.
- A gate being met doesn't commit you to the step. It's the earliest point the step is worth considering, and taking it is still recorded here first, per "How this document is used".
