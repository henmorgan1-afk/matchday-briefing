# Round 4 brief: free AI, ideas 1–5

From Henry (project owner), 14 Oct 2026, for Claude Code on branch `free-to-run`. Read `CLAUDE.md` and SPEC.md (especially Revisions 18–20) before starting.

## Rules for this session

- Work on `free-to-run` only. Don't push, and don't merge into `main`.
- Work through without stopping to ask me anything. If a step needs a permission I haven't given, skip it, carry on, and list it at the end.
- Never open, print or edit `.env`, and never print a secret. To check a variable is set, print only "set" or "missing".
- Don't write to Supabase. Reads are fine.
- Don't add npm packages. Use Node's built-in `fetch` and test runner.
- Commit in logical steps, including this file as `docs/round4-brief.md`.
- Don't run `check-p1.js` if it would start another dry run. Use it only if it can check an existing dry-run file.

## Background

- `main` (commit `882890e`) is live and writes lines with the Claude API on paid credit.
- `free-to-run` (last commit `026d7f7`, never pushed) replaces that with Cloudflare Workers AI: SPEC Revisions 18–20.
- Round 3 (`PROMPT_VERSION` 90a110dd) got every side to at least 4 lines for about 1,250 neurons a match. But it passed one factual error: "Chelsea's attack was a relentless six-goal blitz" (560595: Chelsea scored five; six was the match total).
- My quality bar is now **zero factual errors in published lines**. Occasional style slips are acceptable.

## Don't change

- The 3 STAT / 1 BANTER / 4 HOT_TAKE mix (8 lines written per side).
- The existing code-gate rules, apart from idea 3's change for HOT_TAKE numbers.
- `MIN_PASSING_COUNT` (4), `MAX_GENERATION_ATTEMPTS` (2), the 40-minute and 60-minute limits, and `AI_PROVIDER`.
- Anything under `frontend/`.

## Part 1: catch up

1. Run `git fetch` (read-only) and confirm `main` matches `origin/main` (`882890e`).
2. Merge `main` into `free-to-run`. It has the 13 Oct score-correction fix and the football-data.org footer credit.
   - Resolve conflicts keeping both sides' intent. SPEC.md will probably conflict. Where they clash over the AI code, `free-to-run` wins: the Anthropic SDK stays removed.
   - Afterwards, rerun the existing offline checks: `promptMixProblems`, `promptTailProblems`, the SPEC §3.4 byte-for-byte check, and `node --check` on changed files.
3. Add `GROQ_API_KEY`:
   - to `.env.example`, name only;
   - to `.github/workflows/pipeline.yml`'s job env, from the Actions secret of the same name.

   I've already stored the key in GitHub and in `.env`. Confirm it's set in `.env` without printing it.

## Part 2: SPEC Revision 21

Add "Revision 21 (14 Oct 2026, free AI round 4)" to SPEC.md.

1. Record my decisions:
   - **Quality bar:** no factual errors in published lines. Occasional style slips are acceptable.
   - **Speed and count:** lines appear within a few hours of a match. 4–5 good lines per side is enough: write 8, publish at most 5.
   - **Running:** fully automatic, £0, no card anywhere. More free AI accounts are fine; this round adds Groq's free plan.
   - **Chosen:** ideas 1–5 (this brief) and idea 7 (next round: a Cloudflare Worker cron that dispatches `pipeline.yml` every hour).
   - **Then idea 8, the go-live test:** about 8 finished matches over 2 days, with zero factual errors in published lines, every side at 4 or more, and no failed or unparseable runs.
   - **Parked:** idea 6 (split the work across accounts).
   - **Rejected:** idea 9 (auto-hide a line after thumbs-down), lines or notes written by code, a local model double-checking, manual review, and paying.
2. Record Groq's terms as checked on 14 Oct 2026:
   - The free plan needs no card. Upgrading needs a payment method.
   - Free limits for `qwen/qwen3.8-27b`: 30 requests and 8,000 tokens a minute; 1,000 requests and 200,000 tokens a day; per organisation.
   - The model is listed as Preview: for evaluation, and it may be discontinued at short notice.
   - Services Agreement (last modified 22 Jun 2026): 4.2, Groq may not train on inputs or outputs; 8.1, the customer keeps the rights in inputs and outputs; 3.5a, services and limits can change; 3.6, preview services can be withdrawn at any time.
   - Inference data isn't kept by default; logs may be kept up to 30 days for faults or abuse checks.
3. Add implementation notes and the dry-run results as you go.
4. Update §1 (files, secrets), §3.1 (flow), §3.2 (publish cap), §3.3 (number rule), §3.4 (prompt copies, byte for byte), §3.5 (fact sheet) and §9 to match.

## Part 3: build

The new order for each side:

1. generate (`gpt-oss-120b`, as now);
2. format check and `normaliseDashes()`;
3. first checker (`gpt-oss-120b`, one call per side, as now);
4. code gate (as now, plus idea 3);
5. claim check (idea 2);
6. second checker on Groq (idea 4);
7. duplicates and variety (as now);
8. pick the best (idea 5);
9. write.

Each new step sees only the lines that passed every step before it. The dry-run output records each step's result for every candidate. New `failed_by` values: `claim_check`, `groq`, `unsure` (naming the checker in the reason) and `not_selected`.

### Idea 1: plain-English fact sheet

- New `scripts/lib/fact-sheet.js` builds plain sentences from `buildMatchData`'s output. Code writes facts only. It never writes lines or notes.
- Use team names, never "perspective" or "opponent". For example: "Final score: Chelsea 5, Bournemouth 1. Chelsea scored 5 goals and Bournemouth scored 1. There were 6 goals in the match in total. Martinez plays for Chelsea and made 3 saves."
- Cover:
  - who "we", "us" and "our" mean, and who "they" are;
  - who was at home;
  - the final score, then each team's goals and the match total in separate sentences, so they can't be mixed up;
  - the result and the points;
  - the half-time score and each half's goals, or "The half-time score isn't known.";
  - clean sheets, and whether a side came from behind;
  - the matchday and date;
  - every listed player's team and events. An own goal says which team it counted for. Under-18 players are marked as under 18.
  - a closing sentence that nothing else is known: no goal times, assists, yellow cards, substitutions or positions.
- Add a `{{fact_sheet}}` placeholder above the match data JSON in the generation and checker prompts, introduced as the facts to rely on. Keep the JSON.

### Idea 3: numbers only in STAT

- In `scripts/lib/code-gate.js`: a HOT_TAKE or BANTER line fails if its text or its note contains any number. Use the gate's existing number detection: digits, and number words with the existing "one" idiom exceptions.
- STAT keeps its existing allowed-numbers rule.
- Say so in the generation prompt: HOT_TAKE and BANTER lines and their notes have no numbers or number words; numbers belong in STAT lines.
- Say so in the checker prompt: H1 fails a HOT_TAKE with any number, and H1 and B1 cover the note too.
- This rule alone would have caught "six-goal blitz".

### Idea 2: claim check

- After the code gate, make one call per side to a cheap Cloudflare model. Set `CLAIM_MODEL` in one place, as `@cf/zai-org/glm-4.7-flash`.
  - Turn its reasoning off, or as low as it goes. Check the model's input schema on its Cloudflare page; for GLM this is usually `chat_template_kwargs: { enable_thinking: false }`.
  - Use JSON output mode if the model supports it.
  - If it can't return readable JSON in the dry runs, switch to `@cf/google/gemma-4-26b-a4b-it` and say so.
  - Neurons per million tokens (input / output): glm-4.7-flash 5,500 / 36,400; gemma-4-26b-a4b-it 9,091 / 27,273.
- New prompt file `prompts/claim-check-prompt.md`. Include it in `PROMPT_VERSION` and in §3.4.
- **What it sees:** each line's number, type, text and note; both team names; who "we" are; and the listed players with their teams. It doesn't see the scores or counts, so it reports what a line says, not what the data says.
- **What it returns:** JSON listing every factual claim in each line and its note, with numbers as digits:
  - `team`: `us`, `them` or `match`;
  - `player`: the name as listed, or null;
  - `kind`: goals scored, goals conceded, total goals, winning margin, saves, red card, own goal, penalty missed, penalty saved, score, half-time score, result, points, clean sheet, home or away, came from behind, date or matchday;
  - `period`: `full_time`, `first_half` or `second_half`, where it applies;
  - `value`.

  Two more labels:
  - `unverifiable`: a factual claim the data can't show, such as an assist, when or in what order goals went in beyond the halves, how a goal was scored, a position, a yellow card, a substitution, an injury, a venue name, the table, form or other matches;
  - `culture`: club culture, such as a nickname, a song or how fans behave.

  Opinions are listed as opinions and aren't checked.
- **Code compares every claim with the match data.** A line fails (`failed_by: claim_check`) if:
  - any claim doesn't match;
  - any claim is `unverifiable`, or has a value code can't compare;
  - its extraction is missing or unreadable (fail closed).

  `culture` claims and opinions don't fail a line by themselves.
- Keep each line's count of checked claims. Idea 5 uses it.

### Idea 4: second checker on Groq

- New `scripts/lib/groq-client.js` calls Groq's OpenAI-compatible chat completions API (`https://api.groq.com/openai/v1/chat/completions`) with `GROQ_API_KEY`. The model is `qwen/qwen3.8-27b` (Alibaba's Qwen, a different family from gpt-oss), set in one place. Calls time out after 60 seconds.
- Groq lists this model as **Preview**, so it may be withdrawn at short notice. Make the second checker's provider switchable in one place to Cloudflare with `@cf/google/gemma-4-26b-a4b-it`. Test that path offline, but don't switch.
- **What it checks:** the same checker prompt as the first checker, one call per side, only on lines that passed every earlier step.
- **A line goes live only if both checkers pass it.** Fail closed: a missing, unparseable, "fail" or "unsure" verdict fails the line.
- **Settings:** JSON object mode. Use `reasoning_effort` "low" with `reasoning_format` "hidden" if each call fits the minute limit, otherwise "none". Report which you used and the measured tokens.
- **Limits** (free plan, for the whole organisation): 30 requests and 8,000 tokens a minute; 1,000 requests and 200,000 tokens a day.
  - Groq returns `x-ratelimit-*` headers: `remaining-tokens` and `reset-tokens` are per minute, `remaining-requests` is per day.
  - A 429 comes with `retry-after`.
  - A single request bigger than the minute limit is refused outright.
- **Pacing:**
  - Keep each request's input tokens plus `max_completion_tokens` under the minute limit. Split a side's lines into smaller calls if needed.
  - Before each call, wait if the headers say the minute budget is too low.
  - On a per-minute 429, wait `retry-after` and retry, a few times at most.
- **When Groq can't check, the lines wait for the next run:**
  - **Daily limit reached:** undo the attempt (nothing written, counter restored), start no more matches, and exit 0, like the Cloudflare 3036 case.
  - **Groq down after retries:** do the same, but exit non-zero, so the Actions run shows red.
  - **Unknown or withdrawn model, or a rejected key:** print `GROQ MODEL UNAVAILABLE` or `GROQ KEY REJECTED`, generate nothing, and exit non-zero.
  - **`GROQ_API_KEY` missing at start-up:** generate nothing and exit non-zero.

### Idea 5: keep the best 4–5

- **"Unsure":** both checkers can now answer "unsure" for a rule. Add to the checker prompt, in your own words: if you can't tell whether a rule passes, or it's borderline, answer `unsure: <reason>`; an unsure comment isn't shown, so never guess pass. Unsure counts as a fail.
- **Publishable:** a line is publishable only if it passed every step.
- **Cap:** publish at most 5 live lines per side. Use `MAX_COMMENTS_PER_PERSPECTIVE` for this only if it's purely the live-line cap. If anything else uses it, such as how many candidates get checked, add a separate constant instead. The model still writes 8.
- `MIN_PASSING_COUNT` stays 4, and the second attempt still runs when a side has fewer than 4.
- **Choosing when more than 5 are publishable:**
  - Take turns by type: HOT_TAKE, STAT, BANTER, then round again. So a side gets at least 1 STAT and 1 HOT_TAKE where possible.
  - Within a type, prefer the line with the fewest checked claims, then the order the model wrote them.
  - A second attempt fills only the places left, keeping the spread with the lines already live.
  - Lines left out are `failed_by: not_selected`.

### Offline tests

- Use Node's built-in test runner, in `tests/`, with an npm script `test:offline`.
- Stub every model call: no network, no Supabase, no neurons.
- Cover at least:
  - **the fact sheet**, including an own goal, an under-18 player and an unknown half-time score;
  - **the number rule:** "Chelsea's attack was a relentless six-goal blitz" fails as a HOT_TAKE; "one of the best" passes; a number in a BANTER note fails; a correct STAT passes;
  - **the claim comparison** on 560595-style data (Chelsea 5, Bournemouth 1):
    - a claim that Chelsea scored 6 fails, from either side's perspective;
    - a correct claim passes;
    - `unverifiable` fails, and `culture` passes;
    - a missing or unreadable extraction fails;
  - **Groq:**
    - waiting when the headers say the budget is low;
    - a 429 with `retry-after`;
    - the daily limit (undo, then exit 0) and an outage (undo, then exit non-zero);
    - the unknown-model and rejected-key messages;
    - unparseable or missing verdicts failing closed;
  - **"unsure"** from either checker failing a line;
  - **the selection:**
    - 7 publishable lines become 5, with at least 1 STAT and 1 HOT_TAKE;
    - fewer claims are preferred;
    - only HOT_TAKEs passing gives 5 HOT_TAKEs;
  - **the Cloudflare fallback** for the second checker.
- Keep the existing offline checks passing. Update `check-p1.js`'s assertions to the new rules (published lines, at least 4 per side, the number rule), without making extra model calls.

## Part 4: dry runs

1. Keep the round 3 results: copy `review/dryrun-560595.json` to `review/dryrun-560595-round3.json`, and `review/dryrun-560598.json` to `review/dryrun-560598-round3.json`.
2. Run these once each, one after the other. They use the free Cloudflare allowance (it resets at 01:00 UK time) and Groq's free plan, and write nothing to Supabase:
   - `node scripts/run-pipeline.js --match 560595 --dry-run`
   - `node scripts/run-pipeline.js --match 560598 --dry-run`

   If an allowance or limit runs out, stop and tell me.
3. Fact-check every published line and note yourself against the match data. List any error, however small.
4. Add the results to Revision 21, and commit.

## Final report (plain English)

- What changed, file by file, and the offline test results.
- For each dry run, each side's passed, returned and published counts, and one table per side with columns: type, line, note, published, failed_by, reason.
- Neurons per model and in total, Groq calls and tokens, any time spent waiting, the run time, and estimated matches per day (say which limit runs out first).
- Your fact-check: every factual error or rule break in a published line, and whether each side reached 4 published lines.
- The new `PROMPT_VERSION`.
- Every decision you made.
- Anything you skipped because it needed permission.
- Confirmation that nothing was pushed and `main` wasn't touched.
