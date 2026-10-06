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
- Never claim anything about the order or timing of goals beyond what the
  half-time and full-time scores show (no "while we were already up", no
  "late winner", no "we matched them goal for goal"). Say "came from
  behind" only when half_time_comeback is true.
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
  or a club's fans feel or behave ("always feels like a proper occasion",
  "their fans never need an excuse"). It must not say anything about what
  happened on the pitch in past meetings, including style of play (no "we
  never do a routine 1-0", no "every fixture against them turns into a
  basketball score", no "always try and rough us up", no "we always
  struggle there"), and no specific date or named past incident (you have
  no way to verify those, so don't invent them). Never name a player.
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

For each comment, also write a one-sentence "note":
- STAT: say in plain English what it's based on, for someone who doesn't
  follow football ("From the final score", "From the half-time and final
  scores", "From who scored"). Never use the match data's field names,
  such as total_goals, full_time or own_goal_for_us.
- BANTER: say plainly it's general chat, not a specific claim.
- HOT_TAKE: flag it as a strong take other fans might disagree with. If it
  criticises a named player, also say which of their events it's based on.

Return JSON: a list of 8 objects, each { "type", "text", "note" }.
