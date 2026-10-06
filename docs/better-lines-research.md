Background only. SPEC.md wins where they differ.

# Matchday Briefing: better lines and player data

Oct 6, 2026 · @Henry

## Summary

The lines feel generic because the model only knows the score. **Decided on 6 Oct:** keep football-data.org for scores, add player events from the free Fantasy Premier League (FPL) feed, then add club cards. Everything else waits.

1. **Stage 1, FPL player data:** scorers, own goals, red cards and penalties, cross-checked against football-data.org's score, plus the named-player rules. FPL has no goal minutes.
2. **Stage 2, club cards:** a checked card per club (nicknames, fan attitude, rivals, things never to joke about), so each club's fans sound different.
3. **Later:** write 16 lines and keep the best 8, each from a different angle; rewrite the generator prompt with example lines you write; goal minutes from a second source.

## Why the lines read generic now

The model has almost nothing match-specific to work with, so it writes lines that would fit any match. Four causes, all visible in the current SPEC:

1. **Thin input.** The match data is two scores plus things worked out from them: result, points, margin, home or away, matchday, date. A 2-1 home win for one club and a 2-1 home win for another give the model identical facts, bar the names.
2. **Rules leave little room.** Most of the generation prompt says what not to write: no names, incidents, form, venues, goal order or time words. That's right for safety, but it pushes BANTER towards "how the fixture feels" and HOT\_TAKE towards stock phrases like "put in a shift".
3. **No club context.** The prompt names the club and nothing else, so every club's fans get the same idiom list and the same hedge openers.
4. **No quality selection.** One call writes all 8 lines in one voice, and the pipeline keeps every line that passes the safety check. Nothing rewards a funnier or more specific line over a flat one.

## Free sources for scorers, goal times and red cards

The Premier League's own Fantasy Premier League (FPL) feed is the best free source for who scored and who was sent off. No free source I could confirm gives goal minutes for this season. football-data.org's free tier, which the app uses now, has none of this.

| Source | Scorers and assists | Goal minutes | Red cards | Free for 2026-27? | Terms and risk |
| --- | --- | --- | --- | --- | --- |
| [FPL feed](https://medium.com/@frenzelts/fantasy-premier-league-api-endpoints-a-detailed-guide-acbd5598eb19) | Yes, per match, plus own goals, penalties missed and saves | No | Yes | Yes, no key needed | Unofficial and undocumented, but it's the league's own data. Its terms page only loads in a browser, so I couldn't read it. |
| [ESPN site feed](https://zuplo.com/blog/2024/10/01/espn-hidden-api-guide) | Probably, in each match's "details" list | Probably | Probably | Yes, no key needed | Reverse-engineered, no documentation, can break without warning. It returns 2026-27 fixtures, but I couldn't load a finished match to confirm the details. |
| [API-Football](https://www.api-football.com/pricing) | Yes | Yes | Yes | Probably not: free plans are limited by season, and [one developer reports](https://api.apify.com/v2/actors/1LgsW5JhlqZRpH08g/builds/HhzeLYDhAFYIoQUdW/openapi.json) only 2022 to 2024 | Its [terms](https://www.api-football.com/terms) give no licence to publish the data. 100 requests a day. |
| football-data.org (in use now) | Season top scorers only | No | No | Yes | [Player data isn't on the free tier](https://www.thestatsapi.com/blog/thestatsapi-vs-football-data-org). |

- **Decided (6 Oct):** take scorers, assists, own goals, penalties missed and red cards from the FPL feed. Add goal minutes from ESPN only after a test run works, and only where ESPN agrees with FPL on who scored.
- **A free check that catches bad data:** a team's players' goals plus the opponent's own goals must equal that team's final score from football-data.org. If they don't match, the pipeline ignores player data for that match and writes today's team-level lines instead.
- **API-Football is worth one quick test** before ruling it out: with a free key, ask for one 2026-27 match's events and see whether it answers.
- **Licence:** none of these free sources gives permission to republish its data. That's the same position as football-data.org's non-commercial term today: fine for a no-ads tester build, to settle before ads go on. I'm not a lawyer.
- **Paid sources** with official player data exist. I've left those for when you're on your PC.

## Turning player data into match hooks

Code, not the model, should work out what was interesting about each match. Then every specific claim has a field behind it that the checker and the code gate can test.

&#91;embedded content: proposed pipeline · 2 checks, 1 fallback\]

If the scorers don't add up to the score, that match falls back to today's team-level lines. A failed line never blocks the briefing; the next-ranked line is checked instead.

| Hook | True when | A line it makes possible |
| --- | --- | --- |
| `brace`, `hat_trick` | One of our players scored two, or three or more | "\[Name\] with a brace. Someone get that man a pint." |
| `own_goal_for_us` | The opponent scored an own goal that counted for us | "Even their defence chipped in for us." |
| `our_red_card`, `their_red_card` | A player was sent off | "For me, \[Name\]'s red card cost us, plain and simple." |
| `pen_missed` | One of our players missed a penalty | "Say what you like, but \[Name\] will want that penalty back." |
| `late_winner` (needs minutes) | Our winning goal came in the 85th minute or later | "Left it late. My nerves are shredded." |

Once goal minutes exist, the goal-order rule (E5) can allow claims that the minutes prove, such as a late winner, and still fail anything they don't.

## Making lines funnier and less samey

Write more lines than you need, give each one a different angle, and let a separate pass keep the best. Telling the model to "be funnier" won't fix it on its own.

What the evidence says:

- Twenty professional comedians found AI-written comedy bland and full of stereotyped tropes ([Mirowski et al., 2024](https://arxiv.org/abs/2405.20956)). The fix is specific material to riff on, which player data and club cards supply.
- Chat-tuned models drift to the most typical answer. Asking for several answers along with how likely each is ("Verbalized Sampling") made creative writing 1.6 to 2.1 times more varied, without hurting accuracy or safety ([Zhang et al., 2025](https://arxiv.org/abs/2510.01171v3)).
- Anthropic's own guidance: say what to do rather than what not to do, explain why a rule exists, and give 3 to 5 varied examples ([Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

What to change, in order of value:

1. **Write 16, keep 8.** Ask for 16 candidates per team instead of 8. A ranking call orders them by how specific, funny and different they are. The pipeline then safety-checks them in that order until 8 pass, so the best lines are checked first.
2. **Give every line an angle.** Each candidate gets a different angle from a fixed list: a question to ask a real fan, mock outrage, understatement, absurd comparison, deadpan fact, blame, excuse or hope. The last three come from the "Fake Fan" column in the competitor research. This fixes "too samey" directly.
3. **Ask how typical each line is.** The generator tags each candidate with how likely a typical fan would be to say it. The ranker prefers less typical lines that still pass.
4. **Shorten the generator's rules.** The rules stay in force in the checker and the code gate. The generator gets them as a short list of what to do, each with its reason.
5. **Show the voice.** Add 3 to 5 example lines you write yourself, varied in type and angle, in a new `prompts/examples.md`. Don't copy pundits' lines.
6. **Check variety in code.** The code gate drops a line whose first three words match another passing line's.

## Club voice: one card per club

Give each club a short card of facts about its fans that stay true all season, checked by a person once a season, and let lines draw on it. Fans of different clubs sound different because of who they are, not because of the latest score.

Each card is a file, `data/club-cards/<slug>.json`:

| Field | Example, for a made-up club | Why it's safe |
| --- | --- | --- |
| `nicknames` | "the Larks" | Stable for decades |
| `fan_self_image` | "Proud of a loud away end, always expecting the worst" | An attitude, not a claim about a match |
| `rivals` | The rival club's slug | Changes rarely |
| `running_jokes` | Jokes fans already make about their own club | Fans say them themselves |
| `never_joke_about` | Disasters, deaths and tragedies linked to the club | Jokes about these cause real hurt |
| `reviewed` | "15 Aug 2026, Henry" | Records who checked it and when |

- **Only season-proof facts.** No players, managers, league position or form on a card.
- **A person signs it off.** A model can draft a card, but someone who knows the club checks every line. The pipeline ignores a card with no `reviewed` entry. Asking a fan of each club to check theirs doubles as tester recruitment.
- **The checker treats card contents as known facts.** BANTER can then say "Larks fans" or name the rival. It still can't invent what happened in past meetings (rule B3 stays).
- **`never_joke_about` becomes a rule for every type**, in both prompts and the checker.

## Criticising a named player safely

Allow criticism of a named player only when the line rests on something in the match data about that player: a red card, an own goal or a missed penalty. That turns UK law's "honest opinion" test into rules that code and the checker can enforce.

The defence in [section 3 of the Defamation Act 2013](https://www.legislation.gov.uk/ukpga/2013/26/section/3) (England and Wales) needs three things:

1. The statement is an opinion.
2. It indicates what the opinion is based on.
3. An honest person could hold that opinion on facts that existed when it was published.

It fails if the publisher didn't really hold the opinion. How that applies to lines a model writes is untested, which is one more reason to tie every criticism to a fact. I'm not a lawyer; get advice before ads go on.

| Rule | What it means | How it's caught |
| --- | --- | --- |
| N1: names come from the data | Only players in this match's player data can be named. Managers, referees and officials stay out. | Code gate: every name in a line must be on the match's name list or a club card |
| N2: every named player did something | A named player must have at least one event in the data. "Ran the midfield" or "was anonymous" has nothing behind it. | Code gate checks the event exists |
| N3: criticism matches the fact | Criticism of a named player must state its basis, in the line or its note, and fit that event | New checker rule H3 |
| N4: performance only | Never effort, honesty, character, private life, looks, nationality or injuries | Existing rule H2, extended to individuals |

Two made-up examples:

- Passes: "For me, \[Name\]'s red card cost us, plain and simple." Note: "Strong take on \[Name\]'s red card; not everyone will agree."
- Fails N2: "\[Name\] was anonymous all game." There's no data behind it.

One trade-off: in many matches nobody has a red card, own goal or missed penalty, so named criticism will be rare. Praise of scorers will be common.

Open question: teenage debutants do play in the Premier League, and none of the free sources above gives ages per match. Until one does, decide whether to accept that small risk or keep criticism to team level for any player you can't confirm is an adult.

## What the FPL feed gives us

Two requests per run give Stage 1 everything it needs: per-match goals, own goals, cards, penalties and saves, plus player names and dates of birth. There are no goal minutes.

The [endpoints guide](https://medium.com/@frenzelts/fantasy-premier-league-api-endpoints-a-detailed-guide-acbd5598eb19) dates from October 2020, updated October 2021. Its main endpoints are still in use, but the feed has gained fields since, so build from the live responses, not the guide's screenshots. A [current schema](https://docs.rs/crate/fpl_client/latest/source/fpl_api_docs/schemas/bootstrap-static.md) and a [live request](https://fantasy.premierleague.com/api/fixtures/?future=1) filled in the gaps.

| Endpoint | What we take | Watch out for |
| --- | --- | --- |
| `bootstrap-static/` | Teams: `id`, `code`, `name`, `short_name`. Players: `id`, `web_name`, `first_name`, `second_name`, `known_name`, `birth_date`. | Large; fetch once per run. A player's `team` is their club now, not on match day, so take the side from the fixture instead. |
| `fixtures/?event=<n>` | Per match: `team_h`, `team_a`, both scores, `kickoff_time`, `finished`, `finished_provisional`, and `stats`. `stats` lists goals scored, assists, own goals, penalties saved and missed, yellow and red cards, saves, bonus and bps, each as player id and count for the home and away side. | `minutes` is how long the match has run, not when goals came. Use `stats` from FPL's full-time data, flagged `finished_provisional`. |
| `event/<n>/live/` | Each player's stats and minutes played for a gameweek | Not needed for Stage 1 |
| `event-status/` | When FPL has confirmed a gameweek's data | The guide says bonus and league data update about once a day on matchdays |

The live request returned this season's fixtures with exactly the fixture fields above. It returned upcoming matches only, so the Stage 0 test must confirm a finished match's `stats` for itself.

- **Team mapping.** FPL numbers the 20 teams its own way. Map each to a football-data.org team every run, by three-letter code and then a short fixed alias list (FPL calls Forest NFO, football-data.org calls it NOT), and stop the run unless all 20 map.
- **Pair matches by teams and kickoff date.** FPL's gameweek 6 starts on 10 Oct, the same weekend as football-data.org's matchday 6, but a postponed match can move to another gameweek.
- **Own goals count for the other side.** A team's score is its players' goals plus the opponent's own goals. That sum is the cross-check.
- **No penalty-goal flag.** FPL records penalties missed and saved, but not whether a goal was a penalty.
- **Assists are FPL's own game stat.** Store them, but keep them out of lines until you've compared a few with match reports.
- **Dates of birth settle the under-18 question.** Work out each player's age on match day from `birth_date`.
- **Be polite to the feed.** Two requests per hourly run, a clear User-Agent, no fast retry loops. There's no published limit, and the feed can change without notice.

## Build plan

Player data and the named-player rules ship together in Stage 1, because a name must never reach a line without the checks. Club cards follow in Stage 2. Each stage ends with something you can run and look at.

### Stage 0: a read-only test

- [ ] `scripts/spike-fpl.js` fetches `bootstrap-static/` and `fixtures/?event=5` once each and writes nothing to Supabase.
- [ ] It maps FPL's 20 teams to ours and prints the mapping.
- [ ] For each finished matchday-5 match, it prints scorers, own goals, red cards, penalties and saves, then PASS or MISMATCH on the score cross-check.
- [ ] It prints any player in the stats who was under 18 on match day, and every field name it saw.

**Done when:** 20 of 20 teams map, and every finished matchday-5 match passes.

**Result (6 Oct): passed.** 20 of 20 teams mapped, Forest only through a fallback rule. All 4 stored matchday-5 matches passed the cross-check, including one with an own goal. The other 6 were never stored, so couldn't be checked. Two 16-year-olds appeared in the stats, every player had a date of birth, and 18 short names are shared by more than one player.

### Stage 1: FPL player data

Data (P0):

- [ ] `scripts/lib/fpl-client.js`: two requests per run, a clear User-Agent, no fast retry loops.
- [ ] `teams` gains `fpl_team_id` and `fpl_team_code`, refreshed every run: three-letter code first, then a fixed alias list, never a guess.
- [ ] New table `players`: `fpl_id` (key), `web_name`, `first_name`, `second_name`, `known_name`, `birth_date`, `updated_at`.
- [ ] New table `match_events`: `match_id`, `fpl_id`, `team_id` (from the fixture side), `event` (`goal`, `own_goal`, `assist`, `red_card`, `pen_missed`, `pen_saved`, `saves`), `count`.
- [ ] `matches` gains `fpl_fixture_id` and `player_data`: `pending`, `ok`, `mismatch` or `unavailable`.
- [ ] `fetch-matches.js` stores events as soon as FPL marks the match `finished_provisional` (full time), and only if the cross-check passes. A score correction (§3.6) refetches them.

Generation (P1):

- [ ] **Generation gate:** a finished match is generated once `player_data` is `ok` or `mismatch`, normally on the next hourly run. Each run logs how long FPL's data took to arrive and lists any finished match still waiting. A safety-net cap (`FPL_WAIT_HOURS`) is built but switched off for now; set it from the logged times later.
- [ ] `match-data.js` adds `players` (name, side, events, `under_18`) and `hooks`: `brace`, `hat_trick`, `own_goal_for_us`, `own_goal_against_us`, `our_red_card`, `their_red_card`, `pen_missed`, `pen_saved`. Assists stay out of the prompts for now. When two players in a match share a short name, both go to the prompt under their full names.
- [ ] §3.3 and both prompts swap "no named individuals" for rules N1 to N4, plus **N5: a player under 18 on match day can be named only in STAT lines, and a player with no date of birth counts as under 18.**
- [ ] Code gate: any FPL player's name in a line must belong to a player with an event in this match; under-18 names appear only in STAT lines; player goal and save counts join the allowed numbers.
- [ ] Checker: new rule H3, and S1 accepts claims from `players` and `hooks`.
- [ ] `check-p0.js`: 20 of 20 teams map, and the cross-check holds for every `ok` match. `check-p1.js`: N1, N2 and N5 hold on a dry run of a match with player data.

**Done when:** on matchday 6 (10 to 12 Oct), both checks pass on a match with player data, and you've read its dry-run lines yourself. Matchday-5 briefings stay as they are.

**Decided (6 Oct):** no waiting for FPL's final confirmation. Lines use FPL's full-time data, and the cap stays off until the logged times show what it should be. **Accepted risk:** if a disputed goal is credited to a different player days later, nothing notices, so a cached line could name the old scorer. Revisit only if testers flag it.

### Stage 2: club cards

- [ ] One file per club, `data/club-cards/<slug>.json`, with the fields in the club voice section, plus a check that every file is valid.
- [ ] Claude drafts all 20 with `reviewed` left empty. You, or a fan of each club, check every line and fill in `reviewed`.
- [ ] `match-data.js` passes reviewed cards to both prompts and ignores unreviewed ones.
- [ ] Both prompts and the checker gain the `never_joke_about` rule, and the checker treats card contents as known facts.
- [ ] Comments gain `card_version`.

**Done when:** all 20 cards are reviewed, and a dry run shows card-based lines passing for one of your matches.

### Later, not scheduled

Write 16 lines and keep the best 8, each from a different angle. Example lines in `prompts/examples.md`. The first-three-words variety check. Goal minutes from ESPN. The extra tester question.

## Next step: run it in Claude Code

Start Stage 0 now. If Stage 1 is built before Saturday, matchday 6 (10 to 12 Oct) is its first live test; if not, the next one (17 to 19 Oct) is.

1. Open Claude Code in your `matchday-briefing` folder.
2. Paste **Prompt 1** below. It builds the read-only test and runs it.
3. Check the output: 20 of 20 teams mapped, and PASS for every finished matchday-5 match. If not, paste the whole output into this chat.
4. The wait rule is decided (end of Stage 1 above), and Prompt 2 matches it.
5. Paste **Prompt 2**. Claude Code shows the SPEC.md changes first. Read them, and reply yes only if they match this plan.
6. After matchday 6, ask Claude Code to run `check-p0.js` and `check-p1.js --match <id>` on a match with player data, then read the dry-run lines yourself.
7. Then come back here to start Stage 2: I'll draft the 20 club cards for you to check.

**Prompt 1: the read-only test**

```text
Read SPEC.md first. Don't change it yet.

Build a read-only test, scripts/spike-fpl.js, for the Fantasy Premier League (FPL) public feed. football-data.org stays our source of scores. The script must write nothing to Supabase.

1. Fetch https://fantasy.premierleague.com/api/bootstrap-static/ once and https://fantasy.premierleague.com/api/fixtures/?event=5 once. Send a descriptive User-Agent. No retry loops.
2. Map FPL's 20 teams (id, code, name, short_name) to our teams table: three-letter code first, then normalised name. Print the mapping. Fail unless all 20 map.
3. Pair each FPL fixture with a stored match by home team, away team and kickoff date.
4. For each fixture with finished = true, print goals, own goals, red cards, penalties missed and saved, and saves, by web_name. Take each player's side from the fixture's home/away stats, not from the player's current team.
5. Cross-check: home players' goals + away own goals must equal our stored home score, and the same for away. Print PASS or MISMATCH per match.
6. Print any player in the stats who was under 18 on match day, using birth_date.
7. Print every field name seen on a fixture, in its stats, and on a player.

Run it and show me the output.
```

**Prompt 2: Stage 1**

```text
The FPL test passed: 20 of 20 teams mapped, and all 4 stored matchday-5 matches passed the cross-check. Accept that and don't fetch the other 6. Now do Stage 1.

First add "Revision 9" to SPEC.md §0, including the test's findings, and update §1, §2, §3.1, §3.3, §3.5, §7 and §9 to match the list below. Show me the diff and wait for my yes before writing any code.

Data (P0)
1. scripts/lib/fpl-client.js: bootstrap-static/ and fixtures/?event=<n> once each per run, no fast retry loops. User-Agent: "matchday-briefing/0.1 (+https://didyouseethatludicrousdisplaylastnight.co.uk)".
2. teams: add fpl_team_id and fpl_team_code, mapped every run by three-letter code, then by a fixed FPL_TEAM_ALIASES table in scripts/lib/constants.js (NFO -> NOT). No name or abbreviation guessing. Fail the run unless all 20 map.
3. New table players: fpl_id (primary key), web_name, first_name, second_name, known_name, birth_date, updated_at.
4. New table match_events: match_id, fpl_id, team_id (from the fixture's h/a side), event (goal, own_goal, assist, red_card, pen_missed, pen_saved, saves), count. Unique on (match_id, fpl_id, event). Always key players by fpl_id, because web_names aren't unique. Ignore bonus, bps, yellow_cards and defensive_contribution.
5. matches: add fpl_fixture_id, player_data ('pending', 'ok', 'mismatch', 'unavailable'), finished_seen_at (when our pipeline first stored the match as finished) and fpl_data_at (when FPL's data for it was stored).
6. fetch-matches.js stores events as soon as FPL marks the fixture finished_provisional (full time) and the score cross-check passes ('ok'). Don't wait for FPL's finished flag. On a mismatch it stores none and logs a warning. A score correction (§3.6) refetches events.

Generation (P1)
7. Generation gate: generate a finished match only once player_data is 'ok' or 'mismatch'. Each run prints how long FPL's data took for every match it stored (fpl_data_at minus finished_seen_at), and lists any finished match still 'pending' with how long it has waited. Add FPL_WAIT_HOURS to scripts/lib/constants.js as a safety-net cap that would fall back to team-level lines, but set it to null (off) for now.
8. match-data.js adds players (name, side, events, under_18) and hooks: brace, hat_trick, own_goal_for_us, own_goal_against_us, our_red_card, their_red_card, pen_missed, pen_saved. Keep assists out of the prompts. Use web_name, except when two players in the same match share one: then use both players' full names.
9. §3.3 and both prompts replace "no named individuals" with:
   N1: only players in this match's player data may be named; managers, referees and officials stay banned.
   N2: a named player must have at least one event in the data.
   N3: criticism of a named player must state its basis, in the line or its note, and fit that event (new checker rule H3).
   N4: performance only; never effort, honesty, character, private life, looks, nationality or injuries (extend H2 to individuals).
   N5: a player under 18 on match day may be named only in STAT lines. A player with no birth_date counts as under 18.
10. Code gate: any FPL player's name in a line must belong to a player with an event in this match; under-18 names only in STAT lines; player goal and save counts join the allowed numbers.
11. Checker: S1 accepts claims from players and hooks.

Checks
12. check-p0.js: 20 of 20 teams mapped; the cross-check holds for every 'ok' match; print mismatches and each match's FPL delay.
13. check-p1.js: N1, N2 and N5 hold on a dry run of a match with player data.

Known limit, accepted: if a disputed goal is later credited to a different player, nothing detects it. Record this in Revision 9.

Leave matchday-5 comments as they are. Don't change pipeline.yml's schedule.
```

## All proposed SPEC.md changes

The build plan above now sets the order and adds what the FPL check found. This list stays, with your ticks, as the full reference.

**First, a quick test (no SPEC change):**

- [ ] Fetch FPL fixtures for matchday 5 and confirm, for every finished match, that each team's scorers plus the opponent's own goals add up to the final score already stored.

**P0, data:**

- [ ] New `scripts/lib/fpl-client.js` reads FPL `bootstrap-static/` (player names, teams) and `fixtures/?event=<matchday>` (per-match player stats). It pairs each FPL fixture with a stored match by home team, away team and kickoff date.
- [ ] New table `match_events`: `match_id`, `team_id`, `player_name` (FPL's short name), `event` (`goal`, `own_goal`, `assist`, `red_card`, `pen_missed`, `pen_saved`), `count`, `minute` (null until ESPN is added), `source`.
- [ ] `fetch-matches.js` runs the score cross-check. If it fails, it stores no events for that match and logs a warning, so that match gets today's team-level lines.
- [ ] A score correction (§3.6) also replaces that match's events.
- [ ] Later, optional: `scripts/lib/espn-client.js` fills `minute`, only where ESPN agrees with FPL on the scorers.

**P1, generation:**

- [ ] `match-data.js` adds `players` (name, team, events) and computed `hooks`: `brace`, `hat_trick`, `own_goal_for_us`, `own_goal_against_us`, `our_red_card`, `their_red_card`, `pen_missed`. With minutes, also `early_goal` and `late_winner`.
- [ ] §3.3 replaces "no named individuals" with rules N1 to N4. Managers, referees and officials stay banned.
- [ ] The code gate adds the N1 and N2 name checks and the first-three-words variety check. Player goal counts (and minutes, once added) join the allowed numbers.
- [ ] The checker adds rule H3 and a `never_joke_about` rule. Rule S1 accepts claims from `players` and `hooks`.
- [ ] Club cards live in `data/club-cards/` and go to both prompts. Each comment records the card's `reviewed` value in a new `card_version` column, so card edits don't change `PROMPT_VERSION`.
- [ ] Generation writes 16 candidates, each tagged with an `angle` and a typicality score. A new `scripts/rank-comments.js` orders them, and safety checks run in that order until 8 pass. `TARGET_MIX` stays 2/3/3. Expect up to twice the safety-check calls per match.
- [ ] New `prompts/examples.md` holds 3 to 5 example lines you write. It counts towards `PROMPT_VERSION`.

**Checks:**

- [ ] `check-p0.js`: the score cross-check holds for every finished match that has events.
- [ ] `check-p1.js`: every name in a passing line is on the match's name list, every named player has an event, and no two passing lines share their first three words.

**P4, testers:**

- [ ] The feedback form asks: "Did any line sound like something you'd actually say?"

## Sources

Opened and read:

- [Fantasy Premier League API endpoints guide](https://medium.com/@frenzelts/fantasy-premier-league-api-endpoints-a-detailed-guide-acbd5598eb19) (Oct 2020, updated Oct 2021)
- [FPL fixtures feed, live](https://fantasy.premierleague.com/api/fixtures/?future=1) (upcoming 2026-27 fixtures only)
- [fpl\_client bootstrap-static schema](https://docs.rs/crate/fpl_client/latest/source/fpl_api_docs/schemas/bootstrap-static.md) (third-party description of the current feed)
- [API-Football pricing](https://www.api-football.com/pricing) and [terms of service](https://www.api-football.com/terms)
- [ESPN Premier League scoreboard feed](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard) (2026-27 fixtures; finished-match details not seen)
- [Defamation Act 2013, section 3](https://www.legislation.gov.uk/ukpga/2013/26/section/3)
- [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Zhang et al., Verbalized Sampling](https://arxiv.org/abs/2510.01171)
- [Mirowski et al., A Robot Walks into a Bar](https://arxiv.org/abs/2405.20956)

Seen in search results only, worth opening before building:

- [Zuplo, ESPN's hidden API](https://zuplo.com/blog/2024/10/01/espn-hidden-api-guide)
- [Apify actor note on API-Football's free seasons](https://api.apify.com/v2/actors/1LgsW5JhlqZRpH08g/builds/HhzeLYDhAFYIoQUdW/openapi.json)
- [TheStatsAPI, football-data.org free tier compared](https://www.thestatsapi.com/blog/thestatsapi-vs-football-data-org)

Couldn't read: the [FPL terms page](https://fantasy.premierleague.com/help/terms), which only loads in a browser.
