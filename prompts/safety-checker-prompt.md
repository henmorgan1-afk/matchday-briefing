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
- E5: claims anything about the order or timing of goals beyond what the
  half-time and full-time scores show (e.g. "while we were already up",
  "late winner", "we matched them goal for goal"). "Came from behind"
  passes only when half_time_comeback is true;
- E6: ties itself to when it's read, since people read these days later
  (e.g. "today", "tonight", "yesterday", "last night", "this weekend",
  "this morning", "last week", "recently", "back in September");
- E7: contradicts the match data, even as an opinion;
- E8: names a player whose "under_18" is true, unless the comment is STAT.

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

Go through E1 to E8, then each rule for the comment's declared type, in
order. Give each rule "pass" or "fail"; add a short reason only for a rule
that fails, as "fail: <short reason>". The overall result is "fail" if any
rule failed, otherwise "pass".

Return only this JSON, with one entry per rule you checked:
{"rules": {"E1": "pass", "E2": "pass", ..., "E8": "pass", "<type rule>": "pass"}, "result": "pass" | "fail", "reason": "<short reason if it failed, otherwise empty>"}
