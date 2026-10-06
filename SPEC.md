# Matchday Briefing — Prototype Spec (P0–P5)

Status: P0 built and passing `check-p0.js` (4 Oct 2026). P1 built, with its prompts tightened in three review rounds (Revisions 5–7), and on `main`, where the hourly job has generated briefings for all four finished matchday-5 matches. Under Revision 7, `check-p1.js` passes on all four. P2 built on branch `p2-frontend` (5 Oct 2026, Revision 8). `check-p2.js`'s browser checks pass against a local server. Not yet merged or deployed, so the live-domain checks haven't run. P3–P5 not started. FPL player data (Revision 9, 6 Oct 2026) is built on branch `fpl-player-data` and not yet merged. This document is the build reference for the prototype described in `docs/matchday-briefing-design-doc.md` §10, revised per the interview recorded below, revised again on 22 Sep 2026 after a pre-build review (see "Revision 2" in §0), again on 4–5 Oct 2026 during the P0, P1 and P2 builds (see Revisions 3–8 in §0), and again on 6 Oct 2026 to add player data from the Fantasy Premier League feed (see Revision 9 in §0).

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

### Revision 5 (4 Oct 2026, prompt fixes after reading the P1 dry runs)

The project owner read the four P1 dry runs and made these decisions now rather than leaving them for P5. §3.3, §3.4, §9 and `prompts/*.md` are updated to match. Where anything earlier in this document differs, this note takes precedence.

1. **New rules for every type**, in both prompts:
   - No claims about league position, titles, the table, form, or other matches this season or in past seasons (e.g. "champions elect", "mid-table", "the recurring issue all season"). A clearly personal superlative opinion, like the existing "worst first half I've seen from us all season" example, stays allowed.
   - No venue, stadium or ground names.
   - No claims about the order or timing of goals beyond what the half-time and full-time scores show (e.g. "while we were already up", "late winner"). "Came from behind" only when `half_time_comeback` is true.
2. **`BANTER`:** no numbers or scorelines of any kind, and no claims about how past meetings between the teams went ("we never do a routine 1-0", "every fixture against City turns into a basketball score").
3. **"not at the races"** is removed from the generation prompt's idiom list and added to the checker's lack-of-effort examples, so it always fails.
4. **`check-p1.js`** catches these automatically:
   - The number check now covers every type. Any number in a `HOT_TAKE` must be in the allowed set, and any number at all in a `BANTER` line fails.
   - It fails if any passing line contains "champion", "title", "table", "mid-table", "top four", "relegat" or "league position" (case-insensitive).
5. **Review files.** Each match gets one new dry run, saved to `review/dryrun-<match id>.json`. The Revision 4 dry runs are kept as `review/dryrun-<match id>-v1.json`.

Implementation notes, within those decisions:
- **Banned terms** match at the start of a word, with any ending: "champions", "titles", "relegated" and "Championship" match, but "comfortable", "predictable", "inevitable" and "respectable" don't trip "table". A space or a hyphen counts as the gap in "mid-table", "top four" and "league position", so "top-four" matches too.
- **Number words in `BANTER`.** `check-p1.js` reads number words as numbers ("nil", "zero", "one"…"twenty"). So both prompts' `BANTER` wording spells out "not even number words like 'one' or 'nil'", and the generator, the checker and `check-p1.js` apply one rule. Without it, a line like "one of those grounds" or "the big six" would pass the checker and fail `check-p1.js`. Re-judged under the new check, the Revision 4 dry runs had 15 such lines.
- **"not at the races"** appears in the checker as "in any form, such as 'nowhere near the races'", because the Revision 4 dry run had that variant.
- **`HOT_TAKE` numbers.** No prompt rule limits them. The new every-type rules cover the invented-number cases, such as other matches and form. Only `check-p1.js` limits `HOT_TAKE` numbers, so an idiomatic "one of the best…" in a 5-3 match would pass the checker and fail the check.
- **`PROMPT_VERSION`** is now `d88a6cab`. It was `f9cbb96a` in Revision 4.

**Revision 5 dry-run results** (one run per match, 4 Oct 2026):
- `check-p1.js` passes on 560582, 560583 and 560585 and fails on 560590. The cause is a Sunderland `STAT` line, "…eight goals shipped and scored between us in one game": "one" isn't in that perspective's allowed numbers. The `STAT` number rule is unchanged from §9, and neither prompt says that number words count.
- Passing lines per perspective: 5–8 of 8. Man City got 5, because the checker rightly failed a `HOT_TAKE` that said three goals were conceded before the break, when the half-time score was 3-2.
- None of the Revision 4 problems recurred: no banned terms, no venue names, no numbers in `BANTER`, and no "not at the races".
- Still getting through the checker:
  - a goal-order claim ("we matched them goal for goal in spells");
  - a claim about how past meetings went ("Bournemouth always try and rough us up a bit");
  - one form-trend claim ("our back line is really starting to organise itself");
  - relative time words that go stale once cached ("tonight", "today").
- The checker is inconsistent on "always…"-style `BANTER`. It failed "every time they come to us" but passed "Liverpool always bring a different kind of buzz when they're the visitors".
- Each dry run made 2 generation and 16 safety-check calls and used about 22.1k input tokens (16.2k before, because the prompts are longer) and 3.3–5.1k output tokens. That's about US$0.08–0.09 per match at Sonnet 5's $2/$10 per MTok.

### Revision 6 (5 Oct 2026, second prompt round after the Revision 5 dry runs)

The project owner read the Revision 5 dry runs and made these decisions. §3.3, §3.4, §9 and `prompts/*.md` are updated to match. Where anything earlier in this document differs, this note takes precedence.

1. **Order of goals:** both prompts add "we matched them goal for goal" as an example under the goal-order rule.
2. **Where the `BANTER` line sits**, in both prompts:
   - Allowed: how a fixture, an atmosphere or a club's fans feel or behave ("always feels like a proper occasion", "their fans never need an excuse").
   - Not allowed: anything about what happened on the pitch in past meetings, including style of play ("always try and rough us up", "we always struggle there").
3. **Form and trends:** both prompts add "really starting to organise itself" and "finally clicking" as examples under the league/form rule, because they imply other matches.
4. **Time words:** no line of any type may tie itself to when it's read, because people read these days later. Both prompts ban "today", "tonight", "yesterday", "last night", "this weekend" and "this morning", and `check-p1.js` adds them to its banned terms.
5. **Number words:** the `STAT` and `HOT_TAKE` rules in both prompts say number words count as numbers and must match the match data. In `check-p1.js`, a standalone "one" counts only in score forms ("one-nil", "one-one") or when followed by goal, goals, point or points. Idioms like "one of", "in one game" and "no one" are ignored. All other number rules are unchanged.
6. **Checker consistency:** the safety checker goes through every rule for the comment's type in order, giving pass or fail with a short reason for each, before its overall verdict. The every-type rules come first, then the rule for its type. The JSON keeps `result` and `reason`, so the pipeline reads it as before. The per-rule list comes first, as `rules`.
7. **Review files.** The Revision 5 dry runs are kept as `review/dryrun-<match id>-v2.json`.

Implementation notes, within those decisions:
- **When "one" counts.**
  - It counts when it's joined to another number, or to "all", by a hyphen or en dash with no spaces ("one-nil", "two-one", "one-all"). "One-all" is a score form too.
  - It also counts when the next word, after a space or hyphen, is goal, goals, point or points ("one goal", "one-point").
  - A spaced dash (" - " or " — ") is treated as punctuation, so "matchday 5 - one of those games" doesn't count "one".
  - "One up at the break" doesn't count "one", because it's none of the listed forms.
- **Time words** use the same matcher as the other banned terms: case-insensitive, at the start of a word, any ending. So "today's" and "tonight's" match.
- **The rule list fails closed.** If the checker marks any rule "fail" but returns `"result": "pass"`, the pipeline treats the comment as failed. A missing or malformed `rules` list doesn't fail a comment on its own.
- **Review files show the checker's reasoning.** Dry-run output now includes each candidate's per-rule checks (`rule_checks`) for review. They aren't stored in `comments`.
- **The prompts stay stricter than `check-p1.js` on "one".** The `BANTER` wording from Revision 5 ("not even number words like 'one' or 'nil'") is unchanged, and the `STAT`/`HOT_TAKE` wording says number words count. So the checker can fail an idiomatic "one" that `check-p1.js` now ignores. That costs passing lines, not safety.
- **`PROMPT_VERSION`** is now `b643d89c`. It was `d88a6cab` in Revision 5.

**Revision 6 dry-run results** (one run per match, 5 Oct 2026):
- `check-p1.js` passes on 560582, 560585 and 560590 and fails on 560583, on two Fulham lines the checker passed:
  - "Games against the big six always feel like a different occasion" puts a number in `BANTER`;
  - "we should've found a way to nick all three there" uses 3, which isn't in a draw's match data.
- **The rule-by-rule checker works structurally, but still misses clauses.** It returned 8 rule verdicts for every one of the 64 candidates. But it summarises each type's rule as a single row and can drop clauses. Its `HOT_TAKE` row for "nick all three" covered effort and off-pitch claims, not numbers. It also failed "a 'big six' lot" in one match and passed "the big six" in another.
- **It caught the generator's mistakes:**
  - a half-time margin stated as "two goals up/down" when the score was 3-2, from both sides;
  - two "came back" claims in a match that was level at half-time.
- **Still getting through:**
  - "back in September" in a `STAT` line: reading-time phrasing that isn't on the banned list;
  - `BANTER` that implies what happened on the pitch through "feel" wording ("get through it with a bit of pride intact", "never as straightforward as people think on paper");
  - "one apiece", a score form that `check-p1.js` doesn't count. It was correct here.
- **Cost and time.** Each dry run used about 28.8k input and 13.3k output tokens. Output was 3.3–5.1k before, so the per-rule list is about five times the checker's previous output. That's about US$0.19 per match, or roughly $72 for a 380-match season before retries. Each dry run took 50–54 s.

### Revision 7 (5 Oct 2026, last prompt round before merging)

The project owner read the Revision 6 dry runs and made these decisions. §3.1, §3.3, §3.4, §9 and `prompts/*.md` are updated to match. Where anything earlier in this document differs, this note takes precedence.

1. **Code gate in the pipeline.** `check-p1.js`'s deterministic checks move into shared code, `scripts/lib/code-gate.js`: the number rules for `STAT`, `HOT_TAKE` and `BANTER`, and the banned terms. The pipeline runs them after the model safety check. A line that fails is dropped and logged exactly like a checker fail. `check-p1.js` uses the same code.
2. **Banned terms:** "big six", "back in", "last week" and "recently" are added.
3. **"one apiece"** counts as a score form.
4. **Checker cost.**
   - Each rule still gets its own entry, and every type-specific clause is now an entry of its own, so a `HOT_TAKE`'s number clause is always checked.
   - Each entry is just "pass" or "fail", with a short reason only for rules that fail.
   - The target is well under 300 output tokens per check.
5. **`BANTER` "feel" wording is a deliberate choice.** `BANTER` worded as how a fixture or its fans feel ("pride intact", "never as straightforward as people think") is acceptable. The prompts don't change.
6. **Review files.** The Revision 6 dry runs are kept as `review/dryrun-<match id>-v3.json`.

Implementation notes, within those decisions:
- **Rule IDs.** The checker prompt labels the every-type rules E1–E7, and each type's clauses separately:
  - `STAT`: S1 (claims are in the data) and S2 (numbers);
  - `HOT_TAKE`: H1 (numbers) and H2 (effort, honesty, off the pitch);
  - `BANTER`: B1 (numbers), B2 (dates and named incidents) and B3 (what happened on the pitch in past meetings).

  It replies with `{"rules": {"E1": "pass", …, "H1": "fail: <reason>"}, "result": …, "reason": …}`. The pipeline reads that map, and still reads Revision 6's list form. A rule marked "fail" still fails the comment, whatever the overall result says.
- **The new gate terms are in both prompts too**: "the big six" under the league/form rule, and "last week", "recently" and "back in September" under the time-word rule. Without them, the generator would write lines that get checked, and paid for, only for the gate to drop them.
- **"back in" matches only as whole words**, so "back into" and "back inside" don't trip it. Every other term keeps the start-of-word, any-ending rule, so "last week" also catches "last weekend".
- **The gate runs only on lines the model checker passed**, as decided.
- **Review fields.** Dry-run output marks each failed candidate with `failed_by` (`format`, `checker` or `code_gate`) and records each check's output tokens (`check_output_tokens`). Neither is stored.
- **`check-p1.js` no longer has its own copy of the rules.** The Revision 4 note that it exports `numbersIn`/`allowedNumbers` for `check-p5.js` now refers to `scripts/lib/code-gate.js`.
- **`PROMPT_VERSION`** is now `06791d62`. It was `b643d89c` in Revision 6.

**Revision 7 dry-run results** (one run per match, 5 Oct 2026):
- `check-p1.js` passes on all four matches (560582, 560583, 560585 and 560590), with 6–8 of 8 lines passing per perspective.
- **The code gate caught two checker misses.** It dropped two `BANTER` lines the checker had passed, both "…whenever these two sides meet". The checker listed B1 (numbers) for each and still passed it.
- **Rule coverage was complete.** All 64 checks listed every rule ID for their type: E1–E7 plus that type's clauses.
- **Checker output missed the target.** Per check: mean 296 tokens, median 261, range 136–945, with 20 of 64 checks over 300. That's down from about 720, but not well under 300. The JSON reply itself is short. Most of the rest is adaptive thinking, which the reply format doesn't control.
- **Cost and time.** Each dry run used about 29.8k input and 6.4–7.2k output tokens. That's about US$0.13 per match, or roughly $49 for a 380-match season before retries. Each dry run took 36–47 s.

### Revision 8 (5 Oct 2026, P2 build)

Decisions made while building P2. They include four changes the project owner asked for after reviewing the first build:
- the card order (item 6);
- `include-hidden-files` (items 9 and 11);
- the opposition link and `?match=` (item 12);
- plain-English `STAT` notes (item 13).

§2.1, §3.3, §3.4, §4 and §10 are updated for those. Where anything else in §1, §4, §7 or §9 differs, this note takes precedence.

1. **Thumbs stay on the page until P4.** §4 says a thumbs tap writes to `feedback`, but §7 puts thumbs writes in P4, and P2 was built without starting P4. Each card has thumbs up and down buttons that toggle a pressed state (`aria-pressed`) on the page only. There is no `feedback` write, no `deviceId` and no "You're offline — reaction not saved" toast yet. P4 adds all three to `app.js`.
2. **P2 reads Supabase live.** §7 lists "wire frontend to live Supabase reads" under P3. But §4's picker and briefings, and `check-p2`, need live reads, so P2 does them. That leaves P3 with what `check-p3.js` asserts: identical comments across browsers, and pipeline idempotency. `check-p3.js` and `verify.js` are not built.
3. **Palette and manifest.**
   - The manifest's `theme_color` `#1F5C39` and `background_color` `#F4EFE3` are also the site's two palette tokens (`--colour-pitch` and `--colour-paper` in `style.css`). Every other colour is mixed from them.
   - There's no dark mode, because it would need a second palette that the manifest's colours wouldn't match.
   - `id`, `start_url` and `scope` are `/`. The three icons in `frontend/icons/` are used unchanged, with the maskable one marked `purpose: maskable`.
   - Chrome reports no manifest or installability errors.
4. **`config.js`** sets `self.MATCHDAY_CONFIG = { SUPABASE_URL, SUPABASE_ANON_KEY }`, copied once from `.env`. The key is the `sb_publishable_` key. No other `.env` value appears under `frontend/`.
5. **Supabase reads.** `app.js` sends the publishable key in the `apikey` header only, with no `Authorization` header. A team view makes two reads, or three when a `?match=` id doesn't resolve (item 12):
   - every `teams` row, so a recent or linked team that has left the league still resolves (the picker shows only `in_current_season` rows);
   - one `matches` read with two aliased embeds of `comments`:
     - `own:comments!inner(...)`, filtered to that team's perspective and `superseded_at is null`;
     - `opponent:comments(id)`, filtered to the other perspective and `superseded_at is null`, with limit 1. It exists only to decide whether to show the opposition link.

     The read is ordered by `kickoff_at` descending, with limit 1, and with `&id=eq.<match>` added when the view is pinned to a match. Both embeds must be aliased: with one plain `comments` embed and one aliased, PostgREST didn't apply the plain embed's filters.
6. **Comment order** (the project owner's choice): HOT TAKE cards at the top, then BANTER, then STAT at the bottom. That is `type` descending from the enum order. Rows from one attempt share `created_at`, so within a type the order is `created_at`, then `id`. The order is therefore deterministic, which `check-p3`'s "same order" assertion needs.
7. **Smaller choices.**
   - `recentTeams` holds up to 5 slugs.
   - The date label reads "Last match: Sat 20 Sep". It uses Europe/London time and the same fixed month abbreviations as `match-data.js`, and adds the year only when it isn't the current year. On a view pinned with `?match=` it reads "Match: Sat 20 Sep" instead, because that match may not be the team's latest.
   - The match card shows both teams' `short_name` and the full-time score, plus the half-time score, matchday and competition.
   - Copy copies the line's `text`, not its note.
   - A failed read with nothing cached shows an error message and a "Try again" button (`body[data-state="error"]`). `check-p2` counts that state as a failure.
   - An empty `?team=` shows the homepage.
   - The footer holds only the attribution and the iPhone line. The external feedback-form link is P4.
8. **Service worker.**
   - `pages.yml` stamps `CACHE_VERSION` with the first 12 characters of the commit SHA at deploy time, so nobody has to remember to bump it. The committed value is `'dev'`. The deploy fails if the line isn't found.
   - The app shell (`index.html`, `config.js`, `app.js`, `style.css`, the manifest and the icons) is precached with `cache: 'reload'` and served cache-first. Every navigation gets the cached `index.html`.
   - A new worker calls `skipWaiting` and `clients.claim`, and deletes old shell caches when it activates. So a deploy reaches a tester on the first page load after their browser fetches the new `sw.js`.
   - Supabase reads (`GET` under `/rest/v1/`) are network-first, cached in `matchday-data-v1`. That cache isn't versioned, so it survives shell updates.
   - On a tester's first visit, the worker doesn't control the page yet. `app.js` therefore saves its reads to the same cache itself, and falls back to it. Without that, a tester who opened a link once and then went offline would have nothing cached.
   - When `navigator.onLine` is false, the page shows "You're offline. This is the last version saved on this device." above the briefing.
9. **`pages.yml`** uses the current major version of each action: `actions/checkout@v7`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5` and `actions/deploy-pages@v5`. It runs on pushes to `main` that touch `frontend/**` or the workflow file, and has a manual trigger for the first deploy. Before the first run, set Settings → Pages → Source to "GitHub Actions". The upload step sets `include-hidden-files: true`, because `upload-pages-artifact` v4 and later otherwise leave out dotfiles, and §10's `frontend/.well-known/` must be published.
10. **`check-p2.js`.**
    - `--base <url>` runs it against another copy, such as a local server. The live-domain checks run only against the live domain, and the result says when they were skipped. They are: HTTPS returns 200, and `http://`, `https://www.` and `http://www.` all redirect to the bare domain.
    - It reads Supabase with the publishable key only, so it sees what the frontend sees.
    - It goes beyond §9 in these ways:
      - A team page must show exactly the live comments of that team's latest briefing, which the check works out independently from `comments` and `matches`. A team that has a briefing but shows "No briefing yet" fails.
      - Every card must have a type tag, text, a note, a copy button and thumbs, and the cards must be in HOT_TAKE, BANTER, STAT order. The match card must have a "Last match:" label.
      - Each team page must have the opposition link exactly when the opponent has live comments for that match. The link must point at `?team=<opponent slug>&match=<match id>` and name the opponent.
      - In a fresh browser, the check follows one opposition link. The page it lands on must show exactly the opponent's live comments for that match, with a "Match:" label and a link back. Following it must leave Recent as it was.
      - `?match=` values of `not-a-number`, `999999999`, `-1`, and another team's match must all fall back to the team's latest briefing. A team with no briefing given a real match id must still show "No briefing yet". None of these pages may add to Recent.
      - With today's data, no team has played since its briefing match. So the case where a pinned match differs from the team's latest can't be exercised yet.
      - `sw.js` must activate. Copy must put the line on the clipboard, and the thumbs must toggle.
      - A fresh browser that opened a team link once must show the same cards after reloading with the network off. The check first confirms that an uncached read fails while offline, so it is really testing the cache.
      - The secrets check covers every `.env` value except `SUPABASE_URL` and `SUPABASE_ANON_KEY`, not only the three in §9. It checks the local `frontend/` files as well as the served ones.
    - `package.json` gains `playwright` as a devDependency and a `check:p2` script. `playwright` has no install script, so `pipeline.yml`'s `npm ci` downloads no browsers.
11. **Dotfiles for §10 step 2.** `upload-pages-artifact` v4 and later leave out dotfiles unless `include-hidden-files: true` is set. That input is now set in `pages.yml` (item 9), and §10's note says so.
12. **Opposition link and `?match=`** (the project owner's decision; §2.1 and §4 are updated to match).
    - A team's briefing shows a link such as "See what Sunderland fans are saying →" under the match card. It goes to `?team=<opponent slug>&match=<match id>`, so it still opens that same match if the opponent has played since.
    - The link appears only when the opponent has live comments for that match.
    - The page it opens has its own link back, by the same rule.
    - A `?match=` value is used only if it is 1–12 digits and is a finished match of that team with live comments for that team's perspective. Anything else, such as a non-number, an unknown id, or another team's match, falls back to the team's normal latest briefing. That shows "Last match:", or "No briefing yet" when there's no briefing.
    - **Recent.** Any page opened with a `match` parameter leaves `recentTeams` alone, whether the id is usable or not. That covers following an opposition link. A tester's own team gets into Recent from the picker or a plain `?team=` link.
13. **Plain-English `STAT` notes** (the project owner's decision). The generation prompt now says a `STAT` note must say in plain English what it's based on, for someone who doesn't follow football ("From the final score", "From the half-time and final scores"). It must never use the match data's field names, such as `total_goals` or `full_time`. §3.3 and §3.4 are updated to match, and `prompts/generation-prompt.md` is still byte-for-byte the §3.4 block.
    - `PROMPT_VERSION` is now `b84cf413`. It was `06791d62` in Revision 7.
    - Stored comments are unchanged. They keep their old notes and their old `prompt_version` until a score correction regenerates them.
    - The Revision 7 dry run for 560590 is kept as `review/dryrun-560590-v4.json`.

**P2 findings.**
- Step 1 was `node scripts/run-pipeline.js` with no arguments, run on 5 Oct, and it made 0 generation calls. The hourly job on `main` had already generated all four finished matchday-5 matches. Live comments per perspective (home/away) are:
  - 560582: 8/8
  - 560583: 8/8
  - 560585: 7/8
  - 560590: 8/7

  So 8 of the 20 current-season teams have a briefing. The other 12 show "No briefing yet" until matchday 6 (10–12 Oct).
- `check-p2.js --base http://localhost:8080` passes. It covers 20 picker entries, 20 team pages, the unknown slug, the manifest, `sw.js`, secrets and offline. All 8 briefings have an opposition link. The followed link shows Liverpool's 8 lines for 560582. All four `?match=` fallbacks work, and Recent is unchanged throughout.
- Deliberately broken copies fail as they should:
  - the first build's check failed with 12 problems;
  - after items 6 and 12:
    - a copy with the old card order and the link hidden failed with 17 problems;
    - a copy that adds `?match=` pages to Recent failed with 2.
- While item 12 was being built, the check caught a real bug: the `?match=` id test had lost its backslash (`/^d{1,12}$/`), so every pinned view fell back.
- The live-domain part can't run until the site is deployed on the domain.
- Two things in the stored comments:
  - Some `STAT` notes contain raw field names, which testers will see ("Grounded in total_goals and full_time score"). Item 13 fixes this for new generation only. The stored rows keep these notes.
  - One passing Man City `HOT_TAKE` says "backs against the wall stuff even while we were ahead". That is close to the goal-order rule's banned "while we were already up". It's left for P5.
- **Item 13 dry run** (560590, one run, 5 Oct 2026):
  - `check-p1.js` passes, with Man City 7/8 and Sunderland 8/8. Nothing was written to Supabase.
  - All four `STAT` notes read plainly, for example "From the half-time and final scores" and "From the final score and the match result". No note of any type contains a field name; the previous run's notes had two.
  - The run made 2 generation and 16 safety-check calls, using 29.9k input and 6.9k output tokens, about US$0.13.

### Revision 9 (6 Oct 2026, FPL player data: Stage 0 findings and Stage 1)

Lines read generically because the model knows only the score. The project owner decided to keep football-data.org as the source of scores and add player events (scorers, own goals, red cards, penalties missed and saved, saves) from the free Fantasy Premier League (FPL) feed. Background and options are in `docs/better-lines-research.md` (6 Oct 2026). This revision records the Stage 0 test and specifies Stage 1. §1, §2, §3.1, §3.3–§3.6, §6, §7 and §9 are updated to match. Where anything earlier in this document differs, this note takes precedence. Nothing in it is built yet.

**Stage 0 findings.** `scripts/spike-fpl.js` is a read-only test that writes nothing to Supabase. It was run on 6 Oct 2026 against FPL gameweek 5, and the project owner accepted the result:
- **Team mapping.** All 20 FPL teams map to `teams`. 19 match by three-letter code. Nottingham Forest doesn't: FPL has `NFO` / "Nott'm Forest", and football-data.org has `NOT` / "Nottingham Forest FC". The spike mapped it with a word-by-word abbreviation rule. Stage 1 uses a fixed alias instead (item 2).
- **Score cross-check.** All 10 gameweek-5 fixtures were finished.
  - 4 pair with a stored match (560582, 560583, 560585 and 560590), and all 4 pass the cross-check: each side's players' goals, plus the other side's own goals, equal the stored score. In Fulham 1-1 Man United, Fulham's goal is a Man United own goal.
  - The other 6, played 18–19 Sep, were never stored: when P0 first ran on 4 Oct, its 14-day look-back started at 20 Sep. They weren't checked, and that's accepted.
- **Players under 18.** Two players were under 18 on match day: Nicoll-Jazuli (Chelsea) and Dowman (Arsenal), both 16. Neither had a goal, card or save; they appear only in FPL's `bps` and `defensive_contribution` stats. 16 of FPL's 667 players have no `birth_date`; all 16 have played 0 minutes this season.
- **Names.**
  - `web_name` isn't unique: 18 are shared by more than one player. "Martinez" is both Chelsea's keeper, who made saves in one gameweek-5 match, and the Man United player who scored the own goal in another.
  - Some `web_name`s are also ordinary words ("Cash", "King", "Wood", "Hall"), and 31 include an initial ("A.Becker", "Tóth.A").
- **Feed shape.**
  - A fixture has both `finished` and `finished_provisional`.
  - `minutes` is how long the match has run, not when goals went in. There are no goal minutes and no flag for a penalty goal.
  - `stats` holds 11 identifiers, each with `h` and `a` lists of `{ value, element }`: `goals_scored`, `assists`, `own_goals`, `penalties_saved`, `penalties_missed`, `yellow_cards`, `red_cards`, `saves`, `bonus`, `bps` and `defensive_contribution`.

**Stage 1 decisions** (the project owner's).

Data (P0):
1. `scripts/lib/fpl-client.js` requests `bootstrap-static/` and the fixtures list once each per run. The fixtures request is `fixtures/`, not `fixtures/?event=<n>`; see the implementation notes. It has no fast retry loops and sends the User-Agent `matchday-briefing/0.1 (+https://didyouseethatludicrousdisplaylastnight.co.uk)`.
2. `teams` gains `fpl_team_id` and `fpl_team_code`, mapped every run: by three-letter code, then by the fixed `FPL_TEAM_ALIASES` table in `scripts/lib/constants.js` (`NFO` → `NOT`). There's no name or abbreviation guessing. The run fails unless all 20 map.
3. New table `players`: `fpl_id` (primary key), `web_name`, `first_name`, `second_name`, `known_name`, `birth_date` and `updated_at`.
4. New table `match_events`: `match_id`, `fpl_id`, `team_id` (from the fixture's `h`/`a` side), `event` (`goal`, `own_goal`, `assist`, `red_card`, `pen_missed`, `pen_saved`, `saves`) and `count`, unique on (`match_id`, `fpl_id`, `event`).
   - Players are always keyed by `fpl_id`, because `web_name`s aren't unique.
   - `bonus`, `bps`, `yellow_cards` and `defensive_contribution` are ignored.
5. `matches` gains:
   - `fpl_fixture_id`;
   - `player_data`: `pending`, `ok`, `mismatch` or `unavailable`;
   - `finished_seen_at`: when the pipeline first stored the match as finished;
   - `fpl_data_at`: when FPL's data for it was stored.
6. `fetch-matches.js` stores events as soon as FPL marks the fixture `finished_provisional` (full time), without waiting for FPL's `finished` flag, provided the score cross-check passes (`ok`).
   - On a mismatch it stores none and logs a warning.
   - A score correction (§3.6) refetches events.

Generation (P1):
7. **Generation gate.** A finished match is generated only once `player_data` is `ok` or `mismatch`.
   - Each run prints how long FPL's data took for every match it stored (`fpl_data_at` minus `finished_seen_at`). It also lists every finished match still `pending`, with how long it has waited.
   - `FPL_WAIT_HOURS` in `scripts/lib/constants.js` is a safety-net cap that falls back to team-level lines. It is `null` (off) for now.
8. `match-data.js` adds `players` (name, side, events, `under_18`) and `hooks`: `brace`, `hat_trick`, `own_goal_for_us`, `own_goal_against_us`, `our_red_card`, `their_red_card`, `pen_missed` and `pen_saved`.
   - Assists stay out of the prompts.
   - A player's name is their `web_name`. When two players in the same match share one, both are given their full names instead.
9. §3.3 and both prompts replace "no named individuals" with:
   - **N1:** only players in this match's player data may be named. Managers, referees and officials stay banned.
   - **N2:** a named player must have at least one event in the data.
   - **N3:** criticism of a named player must state its basis, in the line or its note, and fit that event (new checker rule H3).
   - **N4:** performance only: never effort, honesty, character, private life, looks, nationality or injuries (H2 is extended to individuals).
   - **N5:** a player under 18 on match day may be named only in `STAT` lines. A player with no `birth_date` counts as under 18.
10. **Code gate.** Any FPL player's name in a line must belong to a player with an event in this match. Under-18 names are allowed only in `STAT` lines. Player goal and save counts join the allowed numbers.
11. **Checker.** S1 accepts claims from `players` and `hooks`.

Checks:

12. `check-p0.js`: 20 of 20 teams are mapped, and the cross-check holds for every `ok` match. It prints mismatches and each match's FPL delay.
13. `check-p1.js`: N1, N2 and N5 hold on a dry run of a match with player data.

Matchday-5 comments stay as they are, and `pipeline.yml`'s schedule doesn't change.

**Known limit, accepted.** If FPL later credits a goal to a different player, nothing detects it. The same goes for any other event FPL changes after full time. Events are stored once, at full time, and refetched only after a score correction, so lines already written keep the original player.

Implementation notes, within those decisions:
- **One fixtures request, for the whole season.** The client requests `fixtures/`, every fixture of the season, rather than `fixtures/?event=<n>`. That's still one fixtures request per run. Two reasons:
  - Finished matches can be waiting in two gameweeks at once.
  - FPL moves postponed matches into other gameweeks.

  So no single `<n>` covers every run. The request is made only in runs where a finished match is `pending`. Gameweek 5's response was about 25 KB for 10 finished fixtures, so the whole season will be about 1 MB by May. `bootstrap-static/` (about 1.8 MB) is requested every run, because item 2 maps teams every run.
- **Where it runs, and what failure does.** The FPL step runs in `fetch-matches.js`, after the football-data.org upserts and score corrections. If an FPL request fails or fewer than 20 teams map, `fetch-matches.js` throws. Scores and score corrections from football-data.org are already written by then, but the run generates nothing and exits non-zero, as a failed football-data.org fetch already does.
- **Pairing** uses home team, away team and kickoff date in Europe/London, as the spike did. A finished match with no paired fixture stays `pending` and is listed as waiting.
- **Writes.**
  - On `ok`, the match's events are replaced (deleted, then inserted), and `player_data`, `fpl_fixture_id` and `fpl_data_at` are set last. A failed write leaves the match `pending`, so the next run tries again.
  - `fpl_data_at` is also set on `mismatch`, so the delay is measured either way.
  - `players` is upserted from `bootstrap-static/` every run and never deleted from, so a player who leaves the league keeps the row their events point to.
- **Matches finished before Revision 9.** The four matchday-5 matches start as `pending`, like any other finished match. The first run stores their events, because the spike showed all four cross-check. A dry run with player data, such as `check-p1.js --match 560590`, can then be tried before matchday 6.
  - Their comments aren't touched or regenerated, because both perspectives already have at least `MIN_PASSING_COUNT` live lines.
  - Their `finished_seen_at` stays null, so their delay prints as "finished before Revision 9".
- **`unavailable`** is set only by the `FPL_WAIT_HOURS` cap, which is off. The gate accepts `unavailable` as well as `ok` and `mismatch`, so turning the cap on gives a stuck match team-level lines.
- **`BANTER` names no player.** This is checker rule B4, and the code gate applies it too. Every nameable player is nameable only because of an event in this match, and `BANTER` is the type that doesn't refer to this match. Without B4, N3 and N4 wouldn't cover `BANTER`, because H2 and H3 are `HOT_TAKE` rules.
- **Under 18** is worked out from `birth_date` and the kickoff date in Europe/London. A player counts as under 18 until their 18th birthday.
- **What counts as a player's name in the code gate:**
  - their `web_name`;
  - their `web_name` without its initial ("Becker" for "A.Becker", "Tóth" for "Tóth.A");
  - their full name: `known_name` when FPL gives one, otherwise `first_name` and `second_name`.

  Names match as whole words, case-sensitively and ignoring accents. The gate knows only FPL's names. Managers, officials, first names on their own and nicknames are left to the checker. A `web_name` that's also an ordinary word, at the start of a sentence ("Cash", "King"), can drop a line by mistake. That costs a line, not safety.
- **`anon` gets no access to `players` or `match_events`.** The frontend doesn't read them, and `birth_date` is personal data. `check-p0.js` asserts this, as it does for `feedback` and `sessions`.
- **FPL ids are per season.** FPL renumbers its player, team and fixture ids every season. So `players.fpl_id` and `match_events.fpl_id` identify one player only within 2026-27, which is enough for this build. Before next season, `players` needs a season in its key, or FPL's stable player `code`.
- **Checker rule IDs.**
  - New: E8 (N5, under-18 names only in `STAT`), H3 (N3, criticism must state and fit its basis) and B4 (no player in `BANTER`).
  - Reworded: E1 (N1 and N2), E2 (incidents now partly in the data), S1 (accepts `players` and `hooks`) and H2 (N4, extended to individuals).
  - The other rule IDs keep their meaning, so the per-rule map `safety-check.js` reads is unchanged.
- **`PROMPT_VERSION`** was `b8071991` after the first build. It was `b84cf413` in Revision 8. The second prompt round below changes it again.
- **`schema.sql` is one transaction.** The whole file is wrapped in `begin`/`commit`, so if any statement fails, nothing is applied. It was tested on a Postgres engine: running it twice over the Revision 8 schema left every existing row, value, policy and grant unchanged.
- **`scripts/lib/player-data.js`** reads a match's stored events and players, and the name index, for `run-pipeline.js` and `check-p1.js`, so a dry run and its check see the same players.

**First Stage 1 dry run** (560590, 6 Oct 2026, `PROMPT_VERSION` `b8071991`):
- **Setup.** The project owner applied `schema.sql`, and every original row in the five tables was unchanged. The branch's fetch step then mapped 20 of 20 teams and stored events for all four matchday-5 matches, each `ok`. `check-p0.js` passed.
- **Result.** `check-p1.js` passed, with Man City 8/8 and Sunderland 8/8. All 9 player names in passing lines belonged to players with an event in the match, and no `BANTER` line named anyone.
- **Got through the checker:**
  - Sunderland's "going 2-3 down at the break and still scoring twice ourselves" says both goals came after the break. Both came before it.
  - "Brobbey was unplayable up top" states a player's position.
  - "A Sunday kick-off against them" ties `BANTER` to this match's day.
  - Both sides' `BANTER` copied the generation prompt's examples, "always feels like a proper occasion" and "their fans never need … excuse".
  - Several `HOT_TAKE` notes said "in the match data".
- **Not tested:** the match had no red card, missed penalty, own goal or under-18 player, so N3 and N5 weren't tested on real lines.
- **Cost.** About 44.1k input and 7.7k output tokens, or US$0.17 per match against $0.13 in Revision 8. That's roughly $63 for a 380-match season before retries.

**Second prompt round** (6 Oct 2026, the project owner's decisions after reading that dry run). §3.3, §3.4, §3.5, §9 and `prompts/*.md` are updated to match.
1. **Goals by half.** The match data gains `first_half_goals` and `second_half_goals` for each side, worked out from the half-time and full-time scores. Both prompts use them. Checker rule E5 says a claim about either half must match them, with Sunderland's line as an example that fails.
2. **`BANTER` copying the prompt.**
   - The generation prompt no longer gives "always feels like a proper occasion" or "their fans never need an excuse" as examples. The checker's B3 keeps them.
   - The code gate drops any line whose text repeats five or more words in a row from the generation prompt.
3. **Notes.** The plain-English note rule now covers every type. No note may say "match data" or "data", and the code gate checks notes for both.
4. **Checker.**
   - New rule E9: no player positions ("up top", "at the back"), because positions aren't in the data.
   - New rule B5: `BANTER` must not mention this match's day or date.

Implementation notes for the second round:
- **The copy check exempts three idioms:** "Say what you like, but", "second best all over the pitch" and "a game of two halves". The voice reference offers them for reuse, word for word.
  - Measured against the 350 distinct lines in earlier dry runs and stored comments, the rule without the exemption would drop 31 lines. 19 of those are only for these idioms, 17 of them for "Say what you like, but".
  - With the exemption it drops 12. Six repeat banned examples the checker had passed, such as "we matched them goal for goal" and "while we were already up". The other six echo two phrases the prompt itself uses: "two up at the break", from its `STAT` example, and "…I've seen from us all season".
- **Allowed numbers** now include each half's goals, so a line can say how many came in either half.
- **The generation prompt states E9 and B5 too.** Without them, the generator would write lines that get checked, and paid for, only to fail, as Revision 7 noted for the gate's banned terms.
- **Earlier notes.** 7 of the 350 earlier notes say "data".
- **Rule IDs.** The checker now uses E1–E9 and, for `BANTER`, B1–B5.
- **`PROMPT_VERSION`** is now `5fccd873`.
- **Review files.** The first Revision 9 dry run of 560590 is kept as `review/dryrun-560590-v6.json`, and the Revision 7 dry run of 560583 as `review/dryrun-560583-v4.json`.

**Stage 1 is done when** both checks pass on a matchday-6 match with player data (10–12 Oct), and the project owner has read that match's dry-run lines.

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
      fpl-client.js             # FPL feed (§2.3): its two requests, team mapping, fixture pairing, score cross-check
      supabase-client.js        # Supabase client for pipeline and check scripts (service-role key); never deployed
      claude-client.js          # Anthropic SDK wrapper, model IDs pulled from env/constants
      constants.js              # COMMENT_TYPES, STATUS_MAP, TARGET_MIX, MIN_PASSING_COUNT, MAX_COMMENTS_PER_PERSPECTIVE, MAX_GENERATION_ATTEMPTS, FPL_TEAM_ALIASES, FPL_WAIT_HOURS
      match-data.js             # builds the match data JSON sent to both prompts (§3.5); also computes PROMPT_VERSION
      code-gate.js              # deterministic number, banned-term and player-name rules (§3.3)
      player-data.js            # reads stored FPL events, players and the name index (Revision 9)
      slug.js                   # team slug rule (§2.1)
    fetch-matches.js            # P0: upserts teams and matches, applies STATUS_MAP and score corrections, then the FPL step (§2.3)
    spike-fpl.js                # Stage 0 read-only FPL test (Revision 9); writes nothing, kept for reference
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
  - **Schedule: hourly, not tied to kickoff times.** Premier League kickoffs vary (lunchtime, 3pm, evening, midweek), a cron schedule can't follow them, and free-tier scores arrive delayed rather than live. Running every hour is safe because the pipeline only generates for `finished` matches that don't yet have a complete briefing (§3.1), so most runs make two football-data.org requests, one FPL request and no model calls.
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
  - **What the free tier does not return:** goal scorers, goal minutes, assists, bookings, lineups, substitutions, and match statistics (possession, shots and so on). Nothing in this build may depend on football-data.org for them; §3.5 lists exactly what generation can use.
- **Player data (Revision 9):** the Fantasy Premier League (FPL) public feed at `https://fantasy.premierleague.com/api/`. It's unofficial and undocumented, but it's the league's own data, and it needs no key. football-data.org stays the source of every score; FPL only adds who scored, scored an own goal, was sent off, missed or saved a penalty, or made saves, and it's used only where those add up to football-data.org's score (§2.3).
  - Only the pipeline calls it, through `scripts/lib/fpl-client.js`.
  - Each run requests `bootstrap-static/`, which holds teams and players. It also requests `fixtures/`, which holds every fixture with per-player stats, but only when a finished match is waiting for player data.
  - Both requests send the User-Agent `matchday-briefing/0.1 (+https://didyouseethatludicrousdisplaylastnight.co.uk)`, time out after 30 seconds and are never retried within a run. The next hourly run is the retry.
  - FPL gives no goal minutes and doesn't say whether a goal was a penalty.
  - FPL's terms page only loads in a browser, so it hasn't been read. As with football-data.org's non-commercial term, this is fine for a no-ads tester build and **must be revisited before V1 turns on monetisation**.
- **Secrets and config:** five values, named in `.env.example` without values (the FPL feed needs none):
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
create type player_data_status as enum ('pending', 'ok', 'mismatch', 'unavailable');
-- §2.3; the §3.1 generation gate needs 'ok', 'mismatch' or 'unavailable'
create type match_event_type as enum ('goal', 'own_goal', 'assist', 'red_card', 'pen_missed', 'pen_saved', 'saves');

create table teams (
  id text primary key,                -- football-data.org team id
  name text not null,                 -- full name as the API returns it
  short_name text not null,           -- API shortName; shown in the picker and on match cards
  tla text not null,                  -- API three-letter code, e.g. 'ARS'
  slug text not null unique,          -- §2.1; assigned once on insert, never changed
  in_current_season boolean not null, -- true if in the latest competition-teams response
  fpl_team_id int,                    -- §2.3; FPL's team id this season, refreshed every run; null if not one of FPL's 20
  fpl_team_code int,                  -- §2.3; FPL's team code
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
  data_fetched_at timestamptz not null,
  fpl_fixture_id int,                -- §2.3; the FPL fixture it paired with; null until the cross-check runs
  player_data player_data_status not null default 'pending',  -- §2.3
  finished_seen_at timestamptz,      -- when the pipeline first stored it as finished; null if that was before Revision 9
  fpl_data_at timestamptz            -- when FPL's full-time data was cross-checked (and on 'ok', stored); null while pending
);

create table players (               -- §2.3; upserted from FPL's bootstrap-static every run, never deleted
  fpl_id int primary key,            -- FPL element id; FPL renumbers these every season (Revision 9)
  web_name text not null,            -- FPL's short display name; not unique
  first_name text not null,
  second_name text not null,
  known_name text,                   -- FPL's "known as" full name; null when FPL gives none
  birth_date date,                   -- null when FPL gives none; such a player counts as under 18 (§3.3 N5)
  updated_at timestamptz not null
);

create table match_events (          -- §2.3; written only when the match's cross-check passes
  match_id text not null references matches(id),
  fpl_id int not null references players(fpl_id),
  team_id text not null references teams(id),  -- the fixture side the stat was listed under, never the player's current team
  event match_event_type not null,
  count int not null check (count > 0),
  primary key (match_id, fpl_id, event)
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
-- anon has no access at all to players or match_events: the frontend doesn't read them, and birth_date is personal data.
-- service_role has select/insert/update/delete on every table.
```

`teams` is persisted, but it can't drift: `fetch-matches.js` upserts every team from the competition-teams endpoint on every run, sets `in_current_season = true` for those teams and `false` for any other row. Relegated teams keep their rows (older matches still reference them) but drop out of the picker. The frontend reads team names from this table and never calls football-data.org itself.

`schema.sql` adds the Revision 9 types, columns and tables in a way that's safe to re-run, like the rest of the file. Every match that already exists, finished or not, starts as `pending`, so the first run stores events for the four matchday-5 matches without regenerating them (Revision 9).

### 2.1 Team slug rule (`scripts/lib/slug.js`)

Slugs are the `?team=` value in every tester link, so they must be predictable and permanent.

- Built from `short_name`: lower-case it, strip accents, replace `&` with `and`, replace every run of characters other than `a–z` and `0–9` with a single hyphen, and trim hyphens from both ends. For example, a short name of `Man United` becomes `man-united`, and `Arsenal` becomes `arsenal`.
- If the result is already taken by a different team id, append `-` plus the lower-cased `tla`.
- A slug is assigned only when the team's row is first inserted and is never changed afterwards, even if the API later changes the short name. Links already shared keep working.
- The frontend resolves `?team=<slug>` by looking the slug up in `teams`. An unknown slug shows "We don't know that team" above the normal team picker, never a blank page.
- An optional `&match=<football-data.org match id>` pins the team view to that match, for example `?team=sunderland&match=560590`. Opposition links use it (§4), so they keep showing the same match after the team has played again.
  - The id is used only if it is a finished match of that team with live comments for its perspective. Anything else falls back to the team's latest briefing.
  - A page opened with a `match` parameter never adds the team to Recent.

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

### 2.3 FPL player data (`scripts/lib/fpl-client.js`, run by `fetch-matches.js`)

The FPL step runs after the football-data.org upserts and score corrections (§3.6). If an FPL request fails, or the team mapping fails, `fetch-matches.js` throws: the run generates nothing and exits non-zero.

1. **Team mapping**, every run, from `bootstrap-static/`'s `teams`.
   - Each FPL team maps to the current-season `teams` row whose `tla` equals FPL's `short_name`. Failing that, it maps through `FPL_TEAM_ALIASES` in `scripts/lib/constants.js`, which maps FPL's three-letter `short_name` to our `tla`. Today the only entry is `NFO` → `NOT`. There's no name or abbreviation matching.
   - All 20 FPL teams must map, each to a different current-season team, or the step fails before writing anything.
   - Mapped rows get `fpl_team_id` and `fpl_team_code`. Every other row gets null in both.
2. **Players**, every run: every `bootstrap-static/` element is upserted into `players`. FPL's empty `known_name` or `birth_date` is stored as null.
3. **`finished_seen_at`**: when the football-data.org upsert first stores a match as `finished`, `fetch-matches.js` sets its `finished_seen_at` to the run's time. It's never changed after that.
4. **Events**, for every `finished` match whose `player_data` is `pending`. `fixtures/` is requested only if there's at least one such match.
   - **Pairing.** A match pairs with the FPL fixture that has the same home team, the same away team and the same kickoff date in Europe/London, using the team mapping. No fixture pairs, or the fixture's `finished_provisional` is still false: the match stays `pending`. FPL's later `finished` flag isn't waited for.
   - **Cross-check.** For the paired fixture, the home side's score is the home side's `goals_scored` plus the away side's `own_goals`. The away side's score is worked out the same way. Both are compared with the stored full-time score.
   - **`ok`** (both match): the match's events are replaced with the fixture's stats, and then `player_data = 'ok'`, `fpl_fixture_id` and `fpl_data_at` are set. If any of those writes fails, the match stays `pending`, and the next run tries again.
   - **`mismatch`**: no events are stored. `player_data = 'mismatch'`, `fpl_fixture_id` and `fpl_data_at` are set, and it logs `FPL MISMATCH: <match id> stored <h>-<a>, FPL players give <h>-<a>`.
   - **Stats stored as events**, one row per player per event, with `count` = the stat's `value` and `team_id` = the team on the side (`h` or `a`) the stat was listed under:

     | FPL stat | event |
     |---|---|
     | `goals_scored` | `goal` |
     | `own_goals` | `own_goal` (`team_id` is the player's side, the one that conceded it) |
     | `assists` | `assist` (stored, never sent to the prompts) |
     | `red_cards` | `red_card` |
     | `penalties_missed` | `pen_missed` |
     | `penalties_saved` | `pen_saved` |
     | `saves` | `saves` |

     `bonus`, `bps`, `yellow_cards`, `defensive_contribution` and any identifier FPL adds later are ignored.
5. **Waiting.**
   - `FPL_WAIT_HOURS` is `null` (off), so a match waits for FPL for as long as it takes.
   - When it's set to a number, a finished match still `pending` that many hours after `finished_seen_at` becomes `unavailable`. It then gets team-level lines, with no `players` or `hooks`.
6. **Output.** The fetch summary prints:
   - a line for each match whose FPL data was cross-checked this run: its result (`ok` or `mismatch`) and its delay, `fpl_data_at` minus `finished_seen_at`, or "finished before Revision 9" when `finished_seen_at` is null;
   - a line for each finished match still `pending`: how long it has waited since `finished_seen_at`, and why (no paired FPL fixture, or FPL not yet at full time).

FPL ids are per season, and a later correction of who scored isn't detected (Revision 9).

## 3. Generation pipeline (P1)

### 3.1 Trigger and flow (`run-pipeline.js`)

Constants (in `scripts/lib/constants.js`): `MIN_PASSING_COUNT = 4`, `MAX_COMMENTS_PER_PERSPECTIVE = 8`, `MAX_GENERATION_ATTEMPTS = 2`.

1. `fetch-matches.js` upserts `teams`, then upserts the fetched matches into `matches`, mapping statuses with `STATUS_MAP` (§2.2) and applying the score-correction rule (§3.6). Only `finished` matches are eligible for generation; everything else is written with its mapped status and left alone. A match not yet finished when the job runs is simply picked up on a later hourly run — never generated from incomplete data. It then runs the FPL step (§2.3): team mapping, `players`, and events for finished matches waiting on FPL. If the FPL step fails, the run stops here and exits non-zero.
2. For each `finished` match, each perspective (home team, away team) is handled separately. A perspective is **eligible** only if all three are true:
   - it has fewer than `MIN_PASSING_COUNT` live comments (rows with `superseded_at` null), and
   - its attempt counter (`home_generation_attempts` or `away_generation_attempts`) is below `MAX_GENERATION_ATTEMPTS`, and
   - **generation gate (Revision 9):** the match's `player_data` is `ok`, `mismatch` or `unavailable`. A `pending` match waits for FPL (§2.3) and isn't attempted. With `ok`, the match data includes `players` and `hooks`. With `mismatch` or `unavailable`, they're null, and the lines are team-level, as before Revision 9.
3. For each eligible perspective, increment its attempt counter, then call generation once. The counter counts any attempt where the model returned a response, including an unparseable one (which yields zero candidates). If any model call in the attempt fails outright (generation or a safety check: network error, rate limit, outage), write nothing for that attempt, undo the increment, log the error, move on, and make the run exit non-zero so the failure shows red in the Actions tab. The perspective is retried on the next hourly run.
4. Each candidate goes through `safety-check.js`. Every candidate the model checker passes then goes through the **code gate** (`scripts/lib/code-gate.js`): the deterministic number rules, banned terms, name rules, prompt-copy check and note words listed under `check-p1.js` in §9. `check-p1.js` uses the same code. A line the gate fails is dropped and logged exactly like a checker fail. Once every candidate in the attempt has been checked, each passing candidate is written to `comments` with the current `PROMPT_VERSION`, unless:
   - its text matches an existing live comment for that perspective (case-insensitive, whitespace-trimmed), in which case it's dropped as a duplicate, or
   - the perspective already has `MAX_COMMENTS_PER_PERSPECTIVE` live comments.

   Failing candidates are logged with their failure reason and dropped.
5. After the attempt, if the perspective is still below `MIN_PASSING_COUNT` and under `MAX_GENERATION_ATTEMPTS`, it's retried straight away in the same run. Once the cap is reached, whatever passed is accepted, and the perspective is never generated again unless a score correction (§3.6) resets its counter. This is what keeps "generate once, cache" true: a perspective that stays below 4 does not get regenerated every hour.
6. The run ends by printing one summary line per match it touched, e.g. `2026-09-19 ARS v TOT — arsenal: 7/8 passed (attempt 1), tottenham: 8/8 passed (attempt 1)`, followed by `generation calls this run: N`. Before that, the fetch summary prints the FPL lines from §2.3: the delay for every match whose FPL data was stored this run, and every finished match still `pending` with how long it has waited.

Command-line options for `run-pipeline.js`:
- `--match <id>` limits the run to one match. Normal eligibility rules still apply, so a match with a complete briefing is not regenerated; its stored counts are printed instead.
- `--dry-run` must be combined with `--match <id>` and the match must be `finished`. It ignores eligibility, runs one generation attempt per perspective plus safety checking, and prints every candidate with its pass/fail result as JSON. It writes nothing to Supabase and doesn't touch attempt counters. Checks `check-p1.js` and `check-p5.js` use this so they never alter what testers see.
  - Eligibility includes the generation gate, so a `pending` match can be dry-run too.
  - It makes no FPL request. It uses the events already stored: `players` and `hooks` are included when `player_data` is `ok`.
  - The JSON records the match's `player_data`.

### 3.2 Target composition

Per perspective, per match: **8 comments — 2 `STAT` / 3 `BANTER` / 3 `HOT_TAKE`**. This is a target passed to the generation prompt, not a guarantee — the safety checker may unevenly fail one type more than another, and the pipeline does not enforce per-type minimums, only the overall `MIN_PASSING_COUNT = 4`.

### 3.3 Safety rule, by type

- **Every type:**
  - **Named players only from the match's player data (Revision 9).** These rules replace "no named individuals". There is still no lineup or squad data. The model's training knowledge of squads goes out of date with every transfer window, so a name is safe only when the match's FPL events put it there.
    - **N1:** only players in this match's `players` list (§3.5) may be named or clearly identified. Managers, coaches, referees and other officials are never named, and there are no stand-ins for anyone outside the list ("the new signing"). When `players` is null (`player_data` isn't `ok`), nobody is named.
    - **N2:** a named player must have at least one event in the data. `players` lists only players with an event other than an assist, so N1 and N2 are checked together.
    - **N3:** criticism of a named player must state its basis, in the line or its note, and fit that event: "For me, [Name]'s red card cost us" can pass, but "anonymous all game" fails, because no event shows it. This is checker rule H3.
    - **N4:** about a named player, performance only. Never effort, honesty, character, private life, looks, nationality or injuries. This extends checker rule H2 to individuals.
    - **N5:** a player under 18 on match day (`under_18` true, which includes every player with no `birth_date`) may be named only in a `STAT` line.
  - **No specific in-match incidents** that aren't in the match data (§3.5): goal minutes, assists, whether a goal was a penalty, yellow cards, VAR decisions, injuries, substitutions, and any event or count that `players` doesn't show. Neither data source reports these, so any such claim is invented. Who scored, own goals, red cards, missed and saved penalties and save counts are in the data when `players` isn't null.
  - **No league standing, form or other matches.** No claims about league position, titles, the table, form, or other matches this season or in past seasons ("champions elect", "mid-table", "the recurring issue all season"), including trends, which imply other matches ("really starting to organise itself", "finally clicking"). They go stale once cached (§3.5) and can't be checked against the match data. A clearly personal superlative opinion, like "worst first half I've seen from us all season", stays allowed.
  - **No venue, stadium or ground names.** They aren't in the match data.
  - **No player positions** ("up top", "at the back"): positions aren't in the match data. This is checker rule E9 (Revision 9).
  - **No goal order or timing** beyond what the half-time and full-time scores show ("while we were already up", "late winner", "we matched them goal for goal"). Any claim about the goals in either half must match `first_half_goals` or `second_half_goals` (§3.5). "Going 2-3 down at the break and still scoring twice ourselves" fails when both goals came before the break. "Came from behind" is allowed only when `half_time_comeback` is true.
  - **No time words tied to when the line is read.** People read a briefing days after the match, so no "today", "tonight", "yesterday", "last night", "this weekend" or "this morning".
  - **No contradicting the match data**, even in an opinion. A line calling a first half poor when the team led 2-0 at the break fails.
  - **Code gate.** After the model checker, deterministic code drops any line that breaks a number rule (`STAT` and `HOT_TAKE` numbers must be in the match data, including each listed player's goal and save counts; `BANTER` has none), contains a banned term, breaks a name rule, copies five words in a row from the generation prompt, or has a note that says "data". These are the rules `check-p1.js` asserts (§3.1 step 4, §9).
    - **Name rules (Revision 9).** The gate looks for every FPL player's name in the line. A name is the `web_name`, the `web_name` without its initial, or the full name (`known_name`, otherwise `first_name` and `second_name`). It matches whole words, case-sensitively, ignoring accents.
    - Each name found must belong to a player in this perspective's `players` (N1, N2). A name shared by two players in `players` counts only as part of a full name.
    - An under-18 player's name may appear only in a `STAT` line (N5), and a `BANTER` line may name no player at all.
    - The gate knows only FPL's names. Managers, officials, first names on their own and nicknames are left to the checker.
    - **No copying the prompt (Revision 9).** A line whose text repeats five or more words in a row from the generation prompt is dropped. Words are compared lower-cased, ignoring punctuation. A `{{placeholder}}` breaks a run.
    - The exception is the voice reference's three idioms of five words or more: "Say what you like, but", "second best all over the pitch" and "a game of two halves". The prompt offers them for reuse, word for word.
    - **Notes (Revision 9):** no note may say "match data" or "data" (case-insensitive, whole words).
  - **Notes, every type (Revision 9).** A note is plain English for someone who doesn't follow football. It never uses the match data's field names, and never says "match data" or "data".
- **`STAT`** — every specific claim must trace to a field in the match data JSON (§3.5): the final score, the half-time score if present, the result, points, clean sheet, home/away, matchday, kickoff date, and, when present, `players` and `hooks` (who scored, scored an own goal, was sent off, missed or saved a penalty, or made saves, and how many). Checker fails it if any claim isn't in the data, even if the claim might be true (an assist, a league position). Number words count as numbers and must match the data too. `note` says in plain English what grounds it, for someone who doesn't follow football, e.g. "From the final score" or "From the half-time and final scores". It never uses the match data's field names, such as `total_goals` or `full_time`.
- **`HOT_TAKE`** — a strong, explicitly-opinion-framed take about how a **team** played as a whole, or how a player in `players` played (Revision 9).
  - Any number, in digits or words, must match the match data.
  - Positive/enthusiastic: unrestricted, however strong.
  - Negative/critical: allowed to be equally strong on **performance**, but the checker fails any line — regardless of how it's hedged or phrased as opinion — that implies the team, any player or staff lacked effort, were dishonest or cheated, comments on a player's character, private life, looks, nationality or injuries, or refers to anything off the pitch. "Worst first half I've seen from us all season" passes (provided the half-time score doesn't contradict it); "they couldn't be bothered" fails, and so does "not at the races" in any form (it's lack-of-effort phrasing, so it isn't in the prompt's idiom list).
  - Criticism of a named player must rest on one of that player's events and say which, in the line or its note (N3).
  - `note`: an outlier warning, e.g. "Strong take — not everyone will agree." When the line criticises a named player, the note also names the event, e.g. "Strong take based on the red card — not everyone will agree."
- **`BANTER`** — generic, team/rivalry-flavoured, not tied to this match's specific data. Must not contain any number or scoreline of any kind (digits or number words), or state a specific date or named past incident, since there is no historical data source to verify such a claim against yet (this is exactly the "invented fact" risk called out in the interview). It names no player (checker rule B4, Revision 9): every nameable player is nameable only because of this match's events. It doesn't mention this match's day or date, such as "a Sunday kick-off" (checker rule B5, Revision 9). `note`: "General chat, not a specific claim."
  - Allowed: how a fixture, an atmosphere or a club's fans feel or behave ("always feels like a proper occasion", "their fans never need an excuse"). This deliberately includes "feel" wording that hints at how the fixture tends to go, such as "get through it with a bit of pride intact" or "never as straightforward as people think" (Revision 7). Since Revision 9 the two quoted examples are only in the checker's B3, not in the generation prompt, because both sides' `BANTER` copied them.
  - Not allowed: anything about what happened on the pitch in past meetings, including style of play ("we never do a routine 1-0", "every fixture against City turns into a basketball score", "always try and rough us up", "we always struggle there").
  - Parked, not in this build: a historical head-to-head data source, so `BANTER` can eventually make verified specific callbacks.
  - Parked, not in this build: goal minutes from a second source, lineups, and assists in lines. Revision 9's FPL events cover scorers, own goals, red cards, penalties missed and saved, and saves.

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

The match data above is everything that is known about this match. When
"players" isn't null, it lists every player who scored, scored an own
goal, was sent off, missed or saved a penalty, or made a save, with how
many of each; "side" says whether they play for the perspective team or
the opponent, and "hooks" picks out moments from that list. There is no
information about anyone else who played, when goals went in, assists,
yellow cards, whether a goal was a penalty, substitutions or any other
incident. If a field is null, that fact is unknown: don't mention it.

Rules for every comment:
- Name only players listed in "players", exactly as their name is given
  there. Never name or clearly identify anyone else: no other players, no
  managers, coaches or officials, and no stand-ins like "the new
  signing". If "players" is null, name nobody.
- Name a player whose "under_18" is true only in a STAT comment.
- Never describe a specific incident that isn't in the match data (a goal
  at a particular time, an assist, a penalty goal, a yellow card, a VAR
  call, an injury, a substitution), and never give a player an event or
  a count that "players" doesn't show.
- Never claim anything about league position, titles, the table, form, or
  other matches this season or in past seasons (no "champions elect", no
  "mid-table", no "the big six", no "the recurring issue all season"). That
  includes trends, which imply other matches (no "really starting to
  organise itself", no "finally clicking"). A clearly personal superlative
  opinion, like "worst first half I've seen from us all season", is fine.
- Never name a venue, stadium or ground.
- Never say what position a player plays (no "up top", no "at the back"):
  positions aren't in the match data.
- Never claim anything about the order or timing of goals beyond what the
  half-time and full-time scores show (no "while we were already up", no
  "late winner", no "we matched them goal for goal"). first_half_goals and
  second_half_goals say how many goals each side scored in each half, and
  anything you say about the goals in a half must match them. Say "came
  from behind" only when half_time_comeback is true.
- Never tie a line to when it's read: people read these days later. No
  "today", "tonight", "yesterday", "last night", "this weekend", "this
  morning", "last week", "recently" or "back in September".
- Never contradict the match data, even in an opinion.

Write exactly 8 comments in this mix:
- 2 STAT: a short line whose every specific claim is drawn directly from
  the match data above (final score, half-time score if present, result,
  points, clean sheet, home or away, matchday, date, and from "players"
  who scored, scored an own goal, was sent off, missed or saved a
  penalty, or made saves). Nothing else — no league position, no form,
  no season records. Number words count as numbers ("one", "nil",
  "three") and must match the match data too.
- 3 BANTER: generic, team/rivalry-flavoured chat that does NOT reference this
  match's specific events. No numbers or scorelines of any kind, not even
  number words like "one" or "nil". It can say how a fixture, an atmosphere
  or a club's fans feel or behave. It must not say anything about what
  happened on the pitch in past meetings, including style of play (no "we
  never do a routine 1-0", no "every fixture against them turns into a
  basketball score", no "always try and rough us up", no "we always
  struggle there"), and no specific date or named past incident (you have
  no way to verify those, so don't invent them). Never name a player, and
  never mention this match's day or date.
- 3 HOT_TAKE: a strong, clearly-opinion-framed take about how a team played
  as a whole, or how a player listed in "players" played. Positive takes can
  be as enthusiastic as you like. Negative takes can be just as strong about
  PERFORMANCE ("worst first half I've seen from us all season", if the
  half-time score allows it) but must never imply the team, any player or
  staff didn't try, were dishonest, cheated, or say anything about life off
  the pitch — even hedged as opinion. Criticism of a named player must rest
  on one of that player's events in "players" (a red card, an own goal, a
  missed penalty), say which in the line or its note, and stay about that
  event. Never comment on a player's character, private life, looks,
  nationality or injuries. Number words count as numbers ("one", "three")
  and, like digits, must match the match data.

Voice reference — real patterns pulled from how pundits and fans actually
talk (Match of the Day analysis, phone-in shows, live text commentary),
not polished prose:
- Hedge openers before an opinion: "For me,", "If I'm being honest,",
  "I'll be honest,", "Say what you like, but".
- Real idiom, used sparingly and only where it fits: "put in a shift",
  "game management", "backs against the wall", "second best all over the
  pitch", "job done", "a game of two halves".
- Clipped, spoken rhythm over tidy essay sentences — short clauses, the
  odd sentence fragment, dashes instead of semicolons.
- STAT lines read like a live-text snippet (terse, present-feeling: "Two
  up at the break, 3-1 at the end — job done", when the half-time and
  full-time scores say so), not a press-release summary.
Avoid: stacking more than one idiom per line, and any phrase so generic
it could apply to literally any match (that's the AI-generic failure
mode this voice reference exists to prevent).

For each comment, also write a one-sentence "note" in plain English, for
someone who doesn't follow football. Never use the match data's field
names (such as total_goals, full_time or own_goal_for_us), and never the
words "match data" or "data".
- STAT: say what it's based on ("From the final score", "From the
  half-time and final scores", "From who scored").
- BANTER: say plainly it's general chat, not a specific claim.
- HOT_TAKE: flag it as a strong take other fans might disagree with. If it
  criticises a named player, also say which of their events it's based on.

Return JSON: a list of 8 objects, each { "type", "text", "note" }.
```

**`prompts/safety-checker-prompt.md`**:

```
You are checking one football comment against a match's real data before it
ships to a user. Reject anything that could embarrass the user if challenged,
using the rules for its declared type.

Match data:
{{match_data_json}}

Comment to check:
{{comment_json}}

The match data above is everything that is known about this match. When
"players" isn't null, it lists every player who scored, scored an own
goal, was sent off, missed or saved a penalty, or made a save, and
"hooks" is worked out from that list. It has no information about anyone
else who played, goal times, assists, yellow cards, whether a goal was a
penalty, substitutions or any other incident.

Rules for every type — fail the comment if it:
- E1: names or clearly identifies any individual who isn't listed in
  "players": any manager, coach or official, any other player, or a
  stand-in like "the new signing". When "players" is null, naming or
  identifying any individual fails;
- E2: describes a specific incident that isn't in the match data (a goal
  at a particular time, an assist, a penalty goal, a yellow card, a VAR
  call, an injury, a substitution), or gives a player an event or a count
  that "players" doesn't show;
- E3: claims anything about league position, titles, the table, form, or
  other matches this season or in past seasons (e.g. "champions elect",
  "mid-table", "the big six", "the recurring issue all season"), including
  trends that imply other matches (e.g. "really starting to organise
  itself", "finally clicking"). A clearly personal superlative opinion,
  like "worst first half I've seen from us all season", is not a failure;
- E4: names a venue, stadium or ground;
- E5: claims anything about the order or timing of goals beyond what
  first_half_goals, second_half_goals and the half-time and full-time
  scores show (e.g. "while we were already up", "late winner", "we
  matched them goal for goal"). A claim about the goals in either half
  must match first_half_goals or second_half_goals: "going 2-3 down at
  the break and still scoring twice ourselves" fails when both of those
  goals came before the break. "Came from behind" passes only when
  half_time_comeback is true;
- E6: ties itself to when it's read, since people read these days later
  (e.g. "today", "tonight", "yesterday", "last night", "this weekend",
  "this morning", "last week", "recently", "back in September");
- E7: contradicts the match data, even as an opinion;
- E8: names a player whose "under_18" is true, unless the comment is STAT;
- E9: says what position a player plays (e.g. "up top", "at the back"),
  since positions aren't in the match data.

Rules by type — check only the rules for the comment's declared type:
- STAT:
  - S1: fail if any specific claim isn't in the match data above, including
    "players" and "hooks", even if it might be true (an assist, a league
    position, a run of form).
  - S2: fail if any number, in digits or in words ("one", "nil", "three"),
    doesn't match the match data.
- HOT_TAKE (positive or enthusiastic opinions pass, however strong; strong
  criticism of performance alone is not a failure):
  - H1: fail if any number, in digits or in words ("one", "three"),
    doesn't match the match data.
  - H2: fail if it implies, in any phrasing and even hedged as opinion,
    that the team, any player or staff lacked effort, were dishonest or
    cheated, if it comments on a player's character, private life, looks,
    nationality or injuries, or if it refers to anything off the pitch.
    "Couldn't be bothered" and "not at the races" (in any form, such as
    "nowhere near the races") always fail.
  - H3: fail if it criticises a named player without saying, in the text
    or the note, which of that player's events in "players" it's based on,
    or if the criticism goes beyond that event (e.g. "anonymous all game").
- BANTER:
  - B1: fail if it contains any number or scoreline of any kind, in digits
    or in words (including "one" or "nil").
  - B2: fail if it states a specific date or a named past incident.
  - B3: fail if it says anything about what happened on the pitch in past
    meetings, including style of play (e.g. "we never do a routine 1-0",
    "every fixture against City turns into a basketball score", "always
    try and rough us up", "we always struggle there"). Saying how a
    fixture, an atmosphere or a club's fans feel or behave is fine (e.g.
    "always feels like a proper occasion", "their fans never need an
    excuse").
  - B4: fail if it names a player.
  - B5: fail if it mentions this match's day or date (e.g. "a Sunday
    kick-off").

Go through E1 to E9, then each rule for the comment's declared type, in
order. Give each rule "pass" or "fail"; add a short reason only for a rule
that fails, as "fail: <short reason>". The overall result is "fail" if any
rule failed, otherwise "pass".

Return only this JSON, with one entry per rule you checked:
{"rules": {"E1": "pass", "E2": "pass", ..., "E9": "pass", "<type rule>": "pass"}, "result": "pass" | "fail", "reason": "<short reason if it failed, otherwise empty>"}
```

### 3.5 Match data sent to the model (`scripts/lib/match-data.js`)

`buildMatchData(match, perspectiveTeam, opponentTeam, playerData)` produces the `{{match_data_json}}` value for both prompts, so the generator and the checker always see identical facts. `playerData` is the match's stored `match_events` with their `players` rows, or null unless `player_data` is `ok`. Every field is either stored in `matches`/`teams`/`players`/`match_events` or computed deterministically from stored fields; nothing else is ever added. Example: match 560590, Man City 5-3 Sunderland, from Sunderland's perspective, with the gameweek-5 events from the Stage 0 test (Revision 9):

```json
{
  "competition": "Premier League",
  "matchday": 5,
  "kickoff_date": "Sun 20 Sep 2026",
  "perspective_team": "Sunderland",
  "opponent": "Man City",
  "perspective_side": "away",
  "full_time": { "perspective": 3, "opponent": 5 },
  "half_time": { "perspective": 2, "opponent": 3 },
  "first_half_goals": { "perspective": 2, "opponent": 3 },
  "second_half_goals": { "perspective": 1, "opponent": 2 },
  "result": "lost",
  "points_earned": 0,
  "clean_sheet": false,
  "total_goals": 8,
  "winning_margin": 2,
  "half_time_state": "trailing",
  "half_time_comeback": false,
  "players": [
    { "name": "Brobbey", "side": "perspective", "events": { "goal": 3 }, "under_18": false },
    { "name": "Roefs", "side": "perspective", "events": { "saves": 1 }, "under_18": false },
    { "name": "Cherki", "side": "opponent", "events": { "goal": 1 }, "under_18": false },
    { "name": "Donnarumma", "side": "opponent", "events": { "saves": 4 }, "under_18": false },
    { "name": "Enzo", "side": "opponent", "events": { "goal": 1 }, "under_18": false },
    { "name": "Haaland", "side": "opponent", "events": { "goal": 1 }, "under_18": false },
    { "name": "Semenyo", "side": "opponent", "events": { "goal": 2 }, "under_18": false }
  ],
  "hooks": {
    "brace": [],
    "hat_trick": ["Brobbey"],
    "own_goal_for_us": [],
    "own_goal_against_us": [],
    "our_red_card": [],
    "their_red_card": [],
    "pen_missed": [],
    "pen_saved": []
  }
}
```

- Team names are `teams.short_name`.
- `kickoff_date` is formatted in the Europe/London timezone.
- `result` is `won`, `drew` or `lost`; `points_earned` is 3, 1 or 0; `winning_margin` is the absolute goal difference (0 for a draw).
- `half_time`, `half_time_state` (`leading`, `level` or `trailing`) and `half_time_comeback` (trailed at half time and didn't lose) are `null` when the half-time score isn't stored. `matchday` is `null` when the API didn't provide it.
- **`first_half_goals` and `second_half_goals`** (Revision 9) are each side's goals in each half. They're worked out from the half-time and full-time scores, so `first_half_goals` repeats `half_time`. Both are `null` when the half-time score isn't stored. They let a claim about either half be checked (E5): Sunderland scored 2 before the break and 1 after it.
- **`players`** (Revision 9) lists every player with at least one event other than an assist, ordered with the perspective team's players first, then by name.
  - `side` is `perspective` or `opponent`, taken from the event's `team_id`, which comes from the fixture side, never the player's current team.
  - `events` holds that player's non-zero counts of `goal`, `own_goal`, `red_card`, `pen_missed`, `pen_saved` and `saves`. Assists are never included.
  - `under_18` is true when the player was under 18 on the kickoff date (Europe/London), or has no `birth_date`.
- **`name`** is the player's `web_name`. When two players in `players` share a `web_name`, both are given their full names instead: `known_name` when FPL has one, otherwise `first_name` and `second_name`.
- **`hooks`** are worked out from `players`, from the perspective team's point of view. Each is a list of the names it applies to, empty when it doesn't:

  | Hook | Players listed |
  |---|---|
  | `brace` | our players with exactly 2 goals |
  | `hat_trick` | our players with 3 or more goals |
  | `own_goal_for_us` | their players who scored an own goal |
  | `own_goal_against_us` | our players who scored an own goal |
  | `our_red_card` | our players sent off |
  | `their_red_card` | their players sent off |
  | `pen_missed` | our players who missed a penalty |
  | `pen_saved` | our players who saved a penalty |
- `players` and `hooks` are both `null` when `player_data` isn't `ok`. Lines are then team-level, as before Revision 9.
- **Allowed numbers.** Each half's goals and each listed player's goal and save counts join the numbers a `STAT` or `HOT_TAKE` line may use (§9).
- **Deliberately excluded:** league position, the table, form and season records. They change after later matches, so a cached line quoting them would go stale. Also excluded: assists, yellow cards, FPL's bonus, `bps` and `defensive_contribution`, and players with no event (Revision 9).

`PROMPT_VERSION` is also computed here: the first 8 characters of a SHA-256 hash of `prompts/generation-prompt.md`, `prompts/safety-checker-prompt.md` and `TARGET_MIX` together. It changes automatically whenever a prompt or the mix is edited, so there's nothing to remember to bump. Every written comment records it.

### 3.6 Score corrections

If `fetch-matches.js` finds that a match already stored as `finished` now has a different full-time or half-time score from the API:

1. Update the scores.
2. Set `superseded_at = now()` on every live comment for that match (both perspectives). Rows are kept, not deleted, so their `feedback` survives.
3. Reset `home_generation_attempts` and `away_generation_attempts` to 0, so the next step of the same run regenerates both perspectives.
4. Delete the match's `match_events`, set `player_data = 'pending'` and clear `fpl_data_at` (Revision 9). The same run's FPL step (§2.3) then refetches events, and the generation gate holds the match until it has. `finished_seen_at` isn't changed.
5. Log `SCORE CORRECTED: <match id> <old score> -> <new score>` as a warning.

The frontend only ever shows comments with `superseded_at` null, so a line quoting the old score is never shown again.

## 4. Frontend (P2)

- **`frontend/index.html` (homepage):** a text list of the current Premier League teams (read at page load from the Supabase `teams` table where `in_current_season` is true, sorted by `short_name`; never hardcoded and never fetched from football-data.org) as the picker, plus a "Recent" list read from `localStorage` (`recentTeams`, an array of slugs, most-recent-first, capped at a handful). Picking a team, or loading a `?team=` link directly, adds that team to `recentTeams` and navigates to the team view.
- **Team view:** loads that team's most recent `finished` match that has live comments (`superseded_at` null) for that team's perspective, from Supabase. If the team's true next fixture hasn't been played yet or is in progress, this is still their most recent *finished* match — shown with an explicit date label (e.g. "Last match: Sat 13 Sep") so it's never mistaken for a live game. Team names on the match card come from `teams.short_name`.
  - **Card order:** HOT TAKE cards at the top, then BANTER, then STAT at the bottom.
  - **Opposition link.** Under the match card, a link such as "See what Sunderland fans are saying" opens the opponent's lines for the same match: `?team=<opponent slug>&match=<match id>` (§2.1).
    - It's shown only when the opponent has live comments for that match.
    - Opening a team through it doesn't add that team to Recent.
    - A view pinned with `match` labels its date "Match: Sat 13 Sep", because it may not be the team's latest. An unknown or unusable `match` id falls back to the team's normal latest briefing.
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
- Managers, coaches and officials, and any player without an event in the match's FPL data, in any line type. The same goes for in-match incidents neither source reports: goal minutes, assists, whether a goal was a penalty, yellow cards, VAR, injuries and substitutions. Players with an event can be named under §3.3's N1–N5 rules (Revision 9).
- Goal minutes from a second source, club cards, and writing 16 lines to keep the best 8 (later stages of `docs/better-lines-research.md`; not in Revision 9)
- League position, table, form or season records in any line (they go stale once cached; see §3.5)
- Any football-data.org call from the frontend (the pipeline is the only caller; see §1)
- Confidence flag (`verified`/`provisional`) — deliberately dropped for this build, see §3.3

## 7. Phase mapping

| Phase | Scope | Files | Runnable output |
|---|---|---|---|
| **P0 — Data pipeline** | `football-data-client.js`, `fetch-matches.js`, `teams` and `matches` tables, status mapping, slug rule, score corrections, hourly schedule, secrets setup. Revision 9 adds the FPL step: team mapping, `players`, `match_events`, the score cross-check and FPL delay reporting | `scripts/lib/football-data-client.js`, `scripts/lib/fpl-client.js`, `scripts/lib/constants.js`, `scripts/lib/slug.js`, `scripts/fetch-matches.js`, `supabase/schema.sql`, `.github/workflows/pipeline.yml`, `.env.example`, `.gitignore` | `node scripts/fetch-matches.js` populates `teams` (20 current-season rows, each with a slug) and `matches` with real, current PL results; P0 also records whether the free tier returns half-time scores and matchday. Since Revision 9 it also maps all 20 teams to FPL and stores `match_events` for each finished match whose FPL scorers add up to the stored score |
| **P1 — Generation pipeline** | `generate-comments.js`, `safety-check.js`, prompts, match data builder, retry cap, `--match`/`--dry-run`, `run-pipeline.js`. Revision 9 adds the generation gate, `players` and `hooks` in the match data, and rules N1–N5 in the prompts, checker and code gate | `scripts/lib/match-data.js`, `scripts/lib/claude-client.js`, `scripts/lib/code-gate.js`, `scripts/generate-comments.js`, `scripts/safety-check.js`, `prompts/*.md`, `scripts/run-pipeline.js` | `node scripts/run-pipeline.js --match <id>` produces passing, tagged, noted rows in `comments` for both perspectives, each carrying a `prompt_version`. For a match with player data, passing lines name only players with an event in it |
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
  - **FPL (Revision 9).** These read only what's stored; the check makes no FPL request.
    - 20 of 20 current-season `teams` rows have `fpl_team_id` and `fpl_team_code`, and no two share an `fpl_team_id`.
    - For every match with `player_data = 'ok'`, the cross-check holds when recomputed from the stored `match_events`: each side's `goal` events, plus the other side's `own_goal` events, equal its stored full-time score. Every event's `team_id` is the match's home or away team.
    - It prints every `mismatch` match, each match's FPL delay (`fpl_data_at` minus `finished_seen_at`, or "finished before Revision 9"), and every finished match still `pending`, with how long it has waited.
    - The publishable key can't read `players` or `match_events` ("permission denied").
- **`scripts/check-p1.js --match <id>`:** runs `run-pipeline.js --match <id> --dry-run` against a known finished match and asserts:
  - both perspectives have at least 4 passing candidates;
  - every `type` is one of the three valid enum values and every `note` is non-empty;
  - **number check:** every number in a passing `STAT` or `HOT_TAKE` line's text is in the allowed set built from that perspective's match data (full-time and half-time scores, `first_half_goals`, `second_half_goals`, `total_goals`, `winning_margin`, `points_earned`, `matchday`, the day and year in `kickoff_date`, and each listed player's goal and save counts), and a passing `BANTER` line contains no number at all. Numbers are detected both as digits and as number words: `nil`, `zero` and `one` to `twenty`, including hyphenated forms such as `three-one`. A standalone `one` counts only in a score form ("one-nil", "one-one", "one-all", "one apiece") or when followed by goal, goals, point or points; idioms such as "one of", "in one game" and "no one" are ignored.
  - **banned terms:** no passing line's text contains "champion", "title", "table", "mid-table", "top four", "relegat", "league position", "big six", "today", "tonight", "yesterday", "last night", "this weekend", "this morning", "back in", "last week" or "recently". Matching is case-insensitive, at the start of a word, with any ending: "champions", "relegated", "tonight's" and "last weekend" match, but "comfortable" doesn't match "table". The exception is "back in", which must be whole words, so "back into" and "back inside" don't match.
  - **names (N1, N2, N5; Revision 9):**
    - Every FPL player name in a passing line belongs to a player in that perspective's `players`, so has an event in the match.
    - A name shared by two such players appears only as part of a full name.
    - An under-18 player is named only in a `STAT` line, and no `BANTER` line names a player.
    - For a match without player data, any FPL player name fails.
    - The check prints the match's `player_data` and every player named in a passing line. Stage 1 runs it on a match whose `player_data` is `ok`.
  - **prompt copying and notes (Revision 9):** no passing line's text repeats five or more words in a row from the generation prompt, apart from its three long reusable idioms (§3.3), and no passing line's note says "match data" or "data".
  - The number check, banned terms, name rules, copy check and note words are the pipeline's own code gate (`scripts/lib/code-gate.js`, §3.1 step 4). `check-p1.js` re-applies them to the stored match and its stored events, so a line that slipped past the gate still fails the check. It also prints every line the gate dropped, since each one is a line the model checker passed.
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
- **Before step 2:** the Play Store wrap proves the app owns the site with a Digital Asset Links file at `https://didyouseethatludicrousdisplaylastnight.co.uk/.well-known/assetlinks.json`, so it goes in `frontend/.well-known/`. The Actions deploy doesn't run Jekyll. `upload-pages-artifact` v4 and later leave out dotfiles by default, so `pages.yml` sets `include-hidden-files: true` on the upload step, and the dot-folder is published as-is (Revision 8). Also check Google Play's current policy on showing web ads inside a Trusted Web Activity before V1 turns ads on. Don't assume it's allowed. Also re-check the football-data.org commercial-use term (§1) at the same time, since a store listing plus ads is clearly commercial use.
- **Before step 3:** web push (possible from step 1 onward) may cover the "your briefing is ready" notification on Android well enough that step 3 isn't needed for push alone. Test that before choosing Capacitor for push.
- The ~30% install threshold is a starting default, not a researched figure. Change it here if P4 suggests a better bar.
- A gate being met doesn't commit you to the step. It's the earliest point the step is worth considering, and taking it is still recorded here first, per "How this document is used".
