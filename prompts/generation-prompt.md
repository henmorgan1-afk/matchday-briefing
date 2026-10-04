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
- Never claim anything about league position, titles, the table, form, or
  other matches this season or in past seasons (no "champions elect", no
  "mid-table", no "the recurring issue all season"). That includes trends,
  which imply other matches (no "really starting to organise itself", no
  "finally clicking"). A clearly personal superlative opinion, like "worst
  first half I've seen from us all season", is fine.
- Never name a venue, stadium or ground.
- Never claim anything about the order or timing of goals beyond what the
  half-time and full-time scores show (no "while we were already up", no
  "late winner", no "we matched them goal for goal"). Say "came from
  behind" only when half_time_comeback is true.
- Never tie a line to when it's read: people read these days later. No
  "today", "tonight", "yesterday", "last night", "this weekend" or "this
  morning".
- Never contradict the match data, even in an opinion.

Write exactly 8 comments in this mix:
- 2 STAT: a short line whose every specific claim is drawn directly from
  the match data above (final score, half-time score if present, result,
  points, clean sheet, home or away, matchday, date). Nothing else — no
  league position, no form, no season records. Number words count as
  numbers ("one", "nil", "three") and must match the match data too.
- 3 BANTER: generic, team/rivalry-flavoured chat that does NOT reference this
  match's specific events. No numbers or scorelines of any kind, not even
  number words like "one" or "nil". It can say how a fixture, an atmosphere
  or a club's fans feel or behave ("always feels like a proper occasion",
  "their fans never need an excuse"). It must not say anything about what
  happened on the pitch in past meetings, including style of play (no "we
  never do a routine 1-0", no "every fixture against them turns into a
  basketball score", no "always try and rough us up", no "we always
  struggle there"), and no specific date or named past incident (you have
  no way to verify those, so don't invent them).
- 3 HOT_TAKE: a strong, clearly-opinion-framed take about how a team played,
  as a whole. Positive takes can be as enthusiastic as you like. Negative
  takes can be just as strong about PERFORMANCE ("worst first half I've seen
  from us all season", if the half-time score allows it) but must never imply
  the team, its players or staff didn't try, were dishonest, cheated, or say
  anything about life off the pitch — even hedged as opinion. Number words
  count as numbers ("one", "three") and, like digits, must match the match
  data.

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

For each comment, also write a one-sentence "note":
- STAT: name the data field it's grounded in.
- BANTER: say plainly it's general chat, not a specific claim.
- HOT_TAKE: flag it as a strong take other fans might disagree with.

Return JSON: a list of 8 objects, each { "type", "text", "note" }.
