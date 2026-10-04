I'm restarting a project from scratch and I want a complete spec before any code gets written.

## Read these first
@docs/matchday-briefing-design-doc.md and @docs/generation-prompt-draft-v1.md.
Read both before asking me anything.

## The product
Matchday Briefing is a web app that gives football novices short, conversational
talking points about a match they haven't watched, so they can hold their own in
casual chat at work or the pub. The point is outsourcing football knowledge, not
teaching it. Every line must be "safe to say": low embarrassment risk if someone
challenges it.

## Already decided. Do not re-litigate these.
- Web-first. Native mobile (push, widgets) is deferred to a later version.
- Comments are generated in batches per match and cached, never per user.
- The core generation step uses a strong model. Only mechanical preprocessing
  (cleaning, dedupe, format conversion) uses a cheap one.
- Ads, not subscriptions.
- Quiz and knowledge-testing features are cut as off-brand.
- GitHub Pages is the current host.
- Work runs in phases: P0 data pipeline, P1 generation pipeline, P2 minimal
  frontend, P3 connecting and caching, P4 first tester round, P5 iteration.
If you think one of these is wrong, say so once in a single paragraph at the end
of the interview. Don't spend interview questions on it.

## How to interview me
Use the AskUserQuestion tool. Rules:
- I'm a novice developer. When a question involves a technical tradeoff, explain
  each option in one plain-English sentence, including what it costs me later.
- Mark one option as your recommendation so I can take it when I have no opinion.
- One topic per question. Don't batch unrelated things together.
- Don't ask me things you can answer yourself by reading the docs or searching.
  Find the answer, then confirm it with me.
- Skip obvious questions. Dig into the parts I probably haven't thought about.
- If an answer of mine is vague, or contradicts something I said earlier, push
  back and ask again rather than writing it down.

## Dig into these specifically
- Match data: which source, what it actually returns, what happens when it's
  late, wrong or missing, and what the licensing terms let me display.
- "Safe to say" as a testable rule rather than a vibe. What makes a line unsafe,
  and how would we catch an unsafe line automatically before it ships?
- The generation step: input shape, output shape, how many lines per match, tone
  controls, and how a bad batch gets detected and regenerated.
- Factual risk: these are real named players and real events. Invented facts,
  stale scorelines, anything defamatory.
- Freshness: when a briefing is generated relative to kickoff, and what a user
  sees for a match that is upcoming, in progress, postponed, or three days old.
- The frontend: how a user lands on a specific match, what the smallest useful
  screen is, and how a tester link gets shared.
- Ads: where they sit and what they must not break.
- Testers: how I collect their reactions, and what exactly round one is testing.
- What we deliberately will not build in V1.

## Keep going
Don't stop after three questions. Keep interviewing until you have enough to
write a spec another developer could build from without asking me anything.
Then tell me you're done and summarise what you heard before writing anything.

## Then write the spec
Write SPEC.md. It must:
- Name the actual files, modules and data shapes involved, not just describe them.
- State explicitly what is out of scope for V1.
- Map the work to phases P0 to P5, each ending in something I can run and look at.
- End with an end-to-end verification step: the exact command I run to prove the
  whole thing works, and what passing output looks like.
- Include a "Checks" section listing the automated check for each phase, so you
  can verify your own work later without me watching.

Write no code in this session. Spec only.