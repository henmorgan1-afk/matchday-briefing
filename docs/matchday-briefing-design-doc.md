# Matchday Briefing — Design Doc & Roadmap

*Working name. Version 0.3 — 22 Sep 2026*

> **Revision note (22 Sep 2026):** A product interview and a subsequent tone pivot revised two things this doc originally got wrong: the "safe to say" rule (§1, §4) turned out too flat — it hedged everything instead of allowing clearly-flagged banter and strong opinion — and the prototype build plan (§10) is now underspecified next to what's actually needed to build it. **`SPEC.md` is now the authoritative build spec for the P0–P5 prototype** — architecture, data shapes, the real generation/safety-checker prompts, and phase-by-phase checks all live there, and it supersedes this doc wherever they conflict on prototype scope. This doc still holds for the broader V1–V4 roadmap, goals, and anything not covered by `SPEC.md`.

## 1. Problem & concept

People who don't follow football still need to hold their own in conversations about it — at work, in group chats, at the pub. Matchday Briefing turns a team's real results and stats into short, safe, conversational lines the user can drop into a chat without having watched the match or knowing anything about the sport.

The core value isn't "football facts" — it's **confidence without risk of getting caught out**. Originally this meant every line had to be hedged and low-cost to say wrong; revised after testing that framing felt too close to a stats sheet. Now each line carries the kind of confidence it actually deserves: factual talking points stay strictly grounded and low-cost to say wrong, while banter and stronger opinions are clearly flagged as such, so the user always knows which kind of claim they're making before they say it. See `SPEC.md` §3.3 for the type-specific rule this replaced the flat one with.

## 2. Goals

- Get someone from "I have no idea what happened" to "I can hold 30 seconds of conversation" in under a minute of app use
- Never give the user a line that makes them look foolish if challenged
- Work for a specific team the user actually cares about, not generic football trivia

## 3. Non-goals (for now)

- Not a live-scores app or second-screen matchday companion
- Not trying to make the user *actually* knowledgeable — depth is explicitly capped
- Not multi-sport at launch (see V4)
- No quiz/flashcard mode — decided against; the product is about outsourcing the knowledge, not testing retention

## 4. Feature roadmap

### V1 — Core product (MVP)
The smallest version that proves the concept end-to-end for one sport, football.

**Core experience**
- Team/league picker — search and follow multiple teams
- Rivalry/context flags — surface derbies, managers under pressure, injury returns, etc.

**Content**
- Pre-match talking points (not just post-match)
- Player of the match blurb, with a reason
- Historical hooks ("last time these two met…")
- A deliberate mix of registers per match — grounded stats, generic banter, and flagged strong opinions — rather than one hedged tone throughout (see `SPEC.md` §3.2–3.3)

**Personalisation**
- Save/favourite lines already used, to avoid repeats with the same people
- Track which teams/leagues the user has been asked about, to pre-load likely topics

**Trust**
- Confidence flag on stats-heavy lines (verified vs provisional, for mid-match data) — dropped from the P0–P5 prototype, which only ever generates from finished matches, so there's no mid-match uncertainty to flag; revisit once V1 adds pre-match or live content (see `SPEC.md` §3.3)
- A type-tailored trust note on every line — grounding for factual lines, an outlier warning for strong opinions, a plain disclaimer for banter — this is core, not decoration (revised from a single "why this is safe to say" note; see `SPEC.md` §3.3–3.4)

**V1 dependencies:** live sports data API (scores, stats, standings, injuries/lineups), a way to generate conversational copy from that data, basic user accounts to persist follows/favourites.

### V2 — Depth and range
Adds texture once the core loop is proven.

- Difficulty levels ("just the basics" vs "one step further")
- Deflection lines for when the user gets a follow-up question they can't answer

**V2 dependencies:** none new — mostly prompt/content work on top of V1's data pipeline.

### V3 — Distribution and personal fit
Gets the app out of "open it and read a card" and into the user's actual day.

- Push notification when a followed team's match finishes, talking points ready
- Tone picker (dry/sarcastic, earnest, enthusiastic)
- "Who am I talking to" — different lines for a work chat vs a mate who's obsessed
- Widget / lock-screen card with today's one-liner
- Share-to-chat button, formatted for WhatsApp/iMessage/Slack

**V3 dependencies:** push notification infra (web push from the PWA may be enough on Android), native widget support (iOS/Android), share-sheet integration. The widget and share sheet are what trigger the move to a Capacitor native shell (see §6.4).

### V4 — Expansion
- Multi-sport (rugby, cricket, F1, etc.), reusing the football model once it's proven

**V4 dependencies:** abstracting the data pipeline and content model away from football-specific assumptions made in V1.

### Explicitly cut
- Quiz mode — off-brand for the product's premise (outsourcing knowledge, not testing it)

## 5. Suggested build order (roadmap)

| Phase | Focus | Depends on |
|---|---|---|
| **Phase 0 — Foundation** | Pick sports data API; stand up backend that fetches + caches match data; basic team search | — |
| **Phase 1 — V1 content engine** | Generate talking points (post-match) from real data; "why this is safe" note; confidence flagging | Phase 0 |
| **Phase 2 — V1 personalisation** | Accounts, follow multiple teams, save/favourite lines, topic tracking | Phase 1 |
| **Phase 3 — V1 pre-match + context** | Pre-match lines, rivalry/context flags, historical hooks, player-of-match blurb | Phase 1 |
| **Phase 4 — V1 ship** | Polish, test with real matches across a few teams, ship MVP | Phases 1–3 |
| **Phase 5 — V2** | Difficulty levels, deflection lines | Phase 4 live |
| **Phase 6 — V3 distribution** | Push notifications, tone picker, audience picker, widget, share-to-chat | Phase 4 live |
| **Phase 7 — V4** | Generalise data + content pipeline; add a second sport | Phase 6 live |

## 6. Technical decisions (resolved)

These were open questions in v0.1. Resolved after costing out the options — see reasoning below each.

### 6.1 Content generation: API-based LLM, not templated, not self-hosted, not on-device

- **Chosen approach:** call a hosted LLM API (Claude Sonnet 5) per match, batched — two calls generate that match's full comment set, one framed for each team's fans, rather than one call per comment (revised from a single neutral batch once per-team perspective was decided; see `SPEC.md` §2). A second Sonnet 5 pass acts as the safety checker per comment, since judging claims and opinion severity is judgment work, not mechanical preprocessing. Cache the output and serve it to every user following that team/match.
- **Why not templated:** breaks on unusual match situations (red cards, VAR, abandoned games) and reads repetitively at volume — see earlier discussion.
- **Why not self-hosted:** fixed GPU cost regardless of usage, plus real ops burden (scaling, uptime, provisioning for spiky Saturday-afternoon demand), for no quality gain over the API route at this scale.
- **Why not on-device (for V1):** smaller open-source models are noticeably weaker on the nuance and judgement that the "why this is safe to say" framing depends on — the wrong place to cut corners on the product's core differentiator. Revisit as an "unlimited comments" unlock in V3/V4, once there's real usage data showing demand for volume beyond what's cached (see section 8, Parked ideas).

### 6.2 Cost model (worked example, Premier League, 100 comments/match)

- 380 matches/season × 100 comments, batched per match, per team perspective (two calls per match, not per comment)
- Estimated **~£50-60 / ~$70 for a full season** at current API pricing, batched — roughly double the original single-batch estimate now that generation runs once per team perspective rather than once per match (see `SPEC.md` §0)
- Confirms API cost is not a meaningful constraint at this scale — cost only becomes a real factor at much higher league/comment-density, at which point revisit with real usage numbers
- **Caching is the biggest lever**, bigger than model choice: cost scales with *matches covered*, not *users*, so long as generation happens once per match and is served to everyone following it

### 6.3 Monetisation: ads, not subscription

- Given the cost model above, ad revenue comfortably covers generation cost even at low impression volume
- A recurring subscription doesn't fit a lightweight, occasional-use utility like this
- Implication for build: no paywall/billing infrastructure needed for the prototype or V1 — keep this simple until there's a reason not to

### 6.4 Platform: web first, as a PWA, with a staged path to native

- Fastest path to something testers can open without an app store, install, or device-specific build
- **Domain:** the project uses **didyouseethatludicrousdisplaylastnight.co.uk**, which the owner already holds. It's hosted on GitHub Pages under that custom domain, never the default `github.io` address, and set up before the first tester link goes out, because installs and saved preferences are tied to the address a tester first opens. DNS and setup steps are in `SPEC.md` §1.
- **Decided (22 Sep 2026):** the prototype ships as a Progressive Web App, not a plain web page. It's the same static site, but installable to a home screen and able to show cached briefings offline, for about a day of extra work. It keeps "web-first" intact and makes every later platform move a wrap rather than a rewrite.
- Staged route after the prototype, with each step reusing the last: **PWA → Play Store listing (Trusted Web Activity wrap) → Capacitor native shell → full native rewrite only if Capacitor falls short.** Each step waits for evidence: P4 install rates and tester answers decide the Play Store step, and actually scheduling V3's widgets, lock-screen card or share sheet decides the Capacitor step. Gates, costs and pre-checks are in `SPEC.md` §10.
- Options considered and set aside for now: React Native/Flutter (a full frontend rewrite before the product is proven), native Kotlin (Android-only and the steepest learning curve), and a Telegram or WhatsApp bot as the main product (it only reaches that platform's users; the idea may come back as V3's share-to-chat)
- Push notifications, widgets, and share-sheet integration (V3) still need native capabilities. Web push from the PWA may cover the Android notification case on its own, so test that before building a native shell just for push.

## 7. Open questions — resolved

All three of the below were open as of v0.2; resolved during the product interview. Full detail lives in `SPEC.md`, not duplicated here.

- **Data source:** football-data.org, free tier. Covers Premier League scores/results/standings at zero cost; team list fetched dynamically rather than hardcoded. Team crests are not used — separately copyrighted, not covered by the data API's terms. See `SPEC.md` §1.
- **Batching prompt design:** 8 comments per match per team perspective, split 2 `STAT` / 3 `BANTER` / 3 `HOT_TAKE`, each with a type-specific safety rubric and a real voice reference (pundit hedges, genuine football idiom) rather than generic AI phrasing. See `SPEC.md` §3.2–3.4 for the actual prompt drafts.
- **Tester feedback loop:** per-comment thumbs up/down, logged against an anonymous device ID with no accounts, plus a linked external form for open-ended feedback. See `SPEC.md` §5.

## 8. Parked ideas (not in current roadmap)

- **On-device "unlimited comments" unlock** — server-cached 100 comments/match free, then falls back to a bundled on-device open-source model for anything beyond that, as a paid unlock. Technically sound but adds a second generation pipeline (separate prompting/safety testing), device compatibility issues, and download UX to solve a ceiling most users likely won't hit. Worth building only once usage data shows real demand for more than the cached volume.

## 9. Success signals for V1

- A user can go from opening the app to having a usable line in under 60 seconds
- Lines get used (copied/shared), not just viewed
- Low "that was wrong" feedback rate on stats-based lines

## 10. Prototype build plan

Goal: get a testable version — real Premier League data, real LLM-generated comments, in testers' hands — as fast as possible, without building V1's full feature set first. This is deliberately narrower than the V1 roadmap in section 4; it's the smallest thing that proves the core loop works before investing in accounts, personalisation, or notifications.

### What the prototype includes
- One league (Premier League), all 20 teams
- Post-match comments only (pre-match, historical hooks, player-of-match deferred to V1 proper)
- Two comment sets per match, one framed for each team's fans — not neutral (revised; see `SPEC.md` §2)
- Team picker — follow one or more teams
- A type-tailored trust note on every line (revised from a single "why this is safe to say" note into three variants — grounding, outlier warning, vibes disclaimer — see `SPEC.md` §3.3; still non-negotiable, it's the trust mechanic being tested)
- Web app, shareable via a link on didyouseethatludicrousdisplaylastnight.co.uk — no app store submission needed for testers. Built as a PWA, so testers can also install it and read cached briefings offline (see §6.4).

### What the prototype deliberately excludes (vs. full V1)
- Accounts/login — use a simple device-local identifier instead, so testers don't need to sign up
- Save/favourite lines, topic tracking
- Rivalry/context flags — nice-to-have, add if time allows once the core loop works
- Any monetisation/ads — not needed to test the core value
- The mid-match confidence flag ("verified/provisional") — dropped for this build; see the Trust section above
- Verified historical callbacks in banter (e.g. a real "last time these two met" detail) — parked until a historical data source exists; banter stays vibes-only until then

### Build phases and technical detail

Superseded by `SPEC.md`, which is the authoritative build spec for P0–P5: file paths, data shapes, the actual generation and safety-checker prompts, per-phase runnable output, and one automated check per phase all live there. This section originally held a build-phases table and a "start with P0+P1" recommendation — both are carried forward and detailed further in `SPEC.md` §7–9, so they aren't duplicated here.

## 11. Competitor research: ideas and lessons (4 Oct 2026)

From the [Matchday Briefing competitor research](https://claude.ai/code/artifact/cf238208-4484-484e-9705-bf83b69eded1) done on 4 Oct 2026. **These are recorded for later. None of them is a decision, and none changes the P0–P5 build in `SPEC.md`.** To adopt one, write it into `SPEC.md` first, as "How this document is used" in `SPEC.md` requires.

### 11.1 Ideas to borrow

Six ideas from what already exists, roughly in order of value:

1. **End with a question to ask a fan.** Sports Cheat Sheet closes every briefing with one ([developer page](https://jackwallner.github.io/sports/)), and non-fans in the Corporette comments lean on stock questions, such as whether the team is any good this year. A question is the safest line of all, because the fan does the talking.
2. **Group lines by mood after the result.** Westword's "Fake Fan" column, an American-football precedent from the 2007 season, sorted lines after a loss into blame, excuses and hope. Each line carried a one-line note on the fact behind it, and the column also named the right attitude for the week and previewed the next game ([Westword](https://www.westword.com/news/fake-fan-loss-and-sorrow-5854538/)). That is the same job as Matchday Briefing's note under each line, plus two cheap extras.
3. **Let users say who they are talking to.** Sports Cheat Sheet's paid tier offers Office Watercooler, Date Night and other settings, which matches the V3 "Who am I talking to" idea (§4). It is a paid feature there, so it may be worth testing sooner.
4. **Keep it short and finite.** TipOff cut its newsletter to a few hundred words after readers asked for bite-sized ([Nieman Lab](https://www.niemanlab.org/2016/05/tipoff-an-email-newsletter-is-trying-to-explain-sports-to-non-fans/)). Sports Cheat Sheet says a briefing you can finish is the whole point.
5. **Give every issue one shareable line.** TipOff's "Watercooler Words" were a tweet-able sentence or two in every issue, much like the copy button on each comment card. Rivalry Roast adds copy and share buttons and reads each roast aloud.
6. **Plan for big-event spikes.** TipOff's sign-ups grew most around the Super Bowl and the college basketball tournament. For Matchday Briefing, derbies, cup finals and tournaments are the moments to recruit testers.

### 11.2 Things to avoid

Most of the mistakes found are ones `SPEC.md` already guards against; the lesson is to keep those rules.

- **Naming players from a model's memory.** The BluffBall demo tells ChatGPT to name a team's players, from data that stops in 2021 ([Pootlepress](https://www.pootlepress.com/?p=52545)). The ban on named individuals in `SPEC.md` §3.3 is right until there is lineup data.
- **Letting the model supply history.** Rivalry Roast asks Gemini for real historical references with nothing to check them against ([dev.to](https://dev.to/baruna_abirawa_374ef1f781/rivalry-roast-ai-powered-world-cup-banter-generator-4j0e)). That is the invented-fact risk the `BANTER` rule in `SPEC.md` §3.3 blocks.
- **Shipping unchecked answers.** Microsoft Copilot invented a West Ham v Maccabi Tel Aviv match that ended up in a police report ([Windows Central](https://www.windowscentral.com/artificial-intelligence/microsoft-copilot/copilot-blamed-by-uk-police-chief-for-soccer-fan-ban)). The separate safety check is the product's strongest difference, so make it visible in the product.
- **Selling it as "faking it".** The Corporette guide's first tip is not to fake it, and its commenters split over pretending ([Corporette](https://corporette.com/how-to-talk-about-sports-at-work-when-youre-not-a-sports-fan/)). Pitch it as joining in, which is how Sports Cheat Sheet and TipOff describe themselves.
- **Going long.** TipOff's readers complained as issues grew, so keep each team's briefing to one screen.
