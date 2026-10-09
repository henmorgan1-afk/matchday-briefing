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
  a count that "players" doesn't show. Never describe how a goal was
  scored or what it looked like (no header, volley, tap-in, long-range
  strike, "worldie" or "composure"): the match data says only who scored.
- Never claim anything about league position, titles, the table, form, or
  other matches this season or in past seasons (no "champions elect", no
  "mid-table", no "the big six", no "the recurring issue all season"). That
  includes trends, which imply other matches (no "really starting to
  organise itself", no "finally clicking"). A clearly personal superlative
  opinion, like "worst first half I've seen from us all season", is fine.
- Never name a venue, stadium or ground.
- Never say what position a player plays (no "up top", no "at the back"):
  positions aren't in the match data.
- Never criticise or blame a named player in any type of comment, except
  for their red card, own goal or missed penalty. Saves, goals conceded
  and how busy a player was are never grounds, even by implication (no
  "just one save despite us shipping five").
- Never claim anything about the order or timing of goals beyond what the
  half-time and full-time scores show (no "while we were already up", no
  "late winner", no "we matched them goal for goal"). first_half_goals and
  second_half_goals say how many goals each side scored in each half, and
  anything you say about the goals in a half must match them. In a line
  that mentions goals by both sides, use order words ("then", "after",
  "before", "first", "equaliser") only when the goals per half prove that
  order. Say "came from behind" only when half_time_comeback is true.
- Never tie a line to when it's read: people read these days later. No
  "today", "tonight", "yesterday", "last night", "this weekend", "this
  morning", "last week", "recently" or "back in September".
- Never contradict the match data, even in an opinion.

Write exactly 8 comments in this mix:
- 2 STAT: a short line whose every specific claim is drawn directly from
  the match data above (final score, half-time score if present, result,
  points, clean sheet, home or away, matchday, date, and from "players"
  who scored, scored an own goal, was sent off, missed or saved a
  penalty, or made saves). Nothing else: no league position, no form,
  no season records. Number words count as numbers ("one", "nil",
  "three") and must match the match data too. Don't list every scorer,
  and don't recite the half-time and final scores together. Pick the
  single most surprising or telling fact and add a short, dry fan
  reaction of your own that makes no claim. Don't borrow a reaction from
  this prompt.
- 3 BANTER: generic, team/rivalry-flavoured chat that does NOT reference this
  match's specific events. No numbers or scorelines of any kind, not even
  number words like "one" or "nil". It can say how a fixture, an atmosphere
  or a club's fans feel or behave. It must not say anything about what
  happened on the pitch in past meetings, including style of play (no "we
  never do a routine 1-0", no "every fixture against them turns into a
  basketball score", no "always try and rough us up", no "we always
  struggle there"), and no specific date or named past incident (you have
  no way to verify those, so don't invent them). Never name a player, and
  never mention this match's day, date or result. Make at least one a friendly
  wind-up aimed at the other club. Club culture is fair game only when
  it's famous enough that fans of both clubs would know it: a club's
  common nickname or its best-known terrace song. Never invent a chant,
  song or tradition. Keep the wind-up to football: a club, its fans, its
  songs or its nickname. Never mock a town, city, region or accent, money,
  or any tragedy or disaster. No patronising praise or pity for the other
  club ("credit where it's due", "bless them").
- 3 HOT_TAKE: a strong, clearly-opinion-framed take about how a team played
  as a whole, or how a player listed in "players" played. Positive takes can
  be as enthusiastic as you like. Negative takes can be just as strong about
  PERFORMANCE ("worst first half I've seen from us all season", if the
  half-time score allows it) but must never imply the team, any player or
  staff didn't try, were dishonest, cheated, or say anything about life off
  the pitch, even hedged as opinion. Criticism of a named player must rest
  on one of that player's events in "players" (a red card, an own goal, a
  missed penalty), say which in the line or its note, and stay about that
  event. Saves, goals conceded and how busy a player was are never grounds
  for criticising a player. Never comment on a player's character, private life, looks,
  nationality or injuries. Number words count as numbers ("one", "three")
  and, like digits, must match the match data. Exaggerate for comedy only
  in football terms: never compare a performance to a crime, cheating or
  anything off the pitch.

Voice: a British fan texting a mate, not a pundit and not a reporter.
- Everyday British words that someone who doesn't follow football still
  understands ("gutted", "shipped five", "a shocker").
- Dry, deadpan humour. Understated punchlines beat big jokes.
- Short. Every comment is 12 words or fewer.
- Vary the shapes across the 8: some one-liners, some two short
  sentences, the odd question.
- End each sentence at its full stop. Never add a tail after a comma
  ("win or lose", "bless them", "rough one", "no sugar coating it",
  "proper travelling support", "whatever happens on the pitch"). If a
  second thought matters, make it its own short sentence.
- Never use an em dash or a spaced dash. To join two ideas, use a full
  stop. Scores like 5-3 are fine.
- Hedge openers ("For me,", "If I'm being honest,", "I'll be honest,",
  "Say what you like, but") make a take sound like opinion. Use one in at
  most one comment.
- Real idiom, used sparingly and only where it fits: "put in a shift",
  "game management", "backs against the wall", "second best all over the
  pitch", "job done", "three points in the bank", "a game of two halves".
- Tone examples from other, made-up matches. Copy the tone, never the
  words: "Won ugly. Not complaining." (HOT_TAKE),
  "One-nil and a clean sheet. Tidy." (STAT).
Avoid: stacking more than one idiom per line, starting two comments with
the same three words, and any phrase so generic it could apply to
literally any match.

For each comment, also write a "note" in plain English, under 20 words in
all, that helps someone who doesn't follow football use the line. Never
use the match data's field names (such as total_goals, full_time or
own_goal_for_us), and never an em dash. Never write the words "data",
"match data", "player list" or "players" in a note: say "From who scored"
or "From the final score" instead. Never name a player's position in a
note either (no "the keeper").
- STAT: say what it's based on ("From the final score", "From who
  scored"), and explain any football term in the line ("A hat-trick is
  three goals by one player").
- BANTER: say it's general chat, not about this match, and explain any
  nickname or song it uses ("The Black Cats is Sunderland's nickname").
- HOT_TAKE: flag it as a strong take other fans might disagree with. If it
  criticises a named player, also say which of their events it's based on.

Return JSON: a list of 8 objects, each { "type", "text", "note" }.
