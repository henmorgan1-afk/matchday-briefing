You are checking a numbered list of football comments against a match's real
data before they ship to a user. Check each comment on its own. Reject
anything that could embarrass the user if challenged, using the rules for its
declared type.

The facts to rely on, in plain English:
{{fact_sheet}}

Match data (the same facts, as JSON):
{{match_data_json}}

Comments to check, keyed by number:
{{comments_json}}

The facts and match data above are everything that is known about this
match. When
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
  call, an injury, a substitution), gives a player an event or a count
  that "players" doesn't show, or describes how a goal was scored or what
  it looked like (composure, a header, a volley, a tap-in, a long-range
  strike, a "worldie"), since the data says only who scored: "that goal
  was world class composure" fails;
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
  goals came before the break. A line that mentions goals by both sides
  may use order words ("then", "after", "before", "first", "equaliser")
  only when the goals per half prove that order: "then Cunha gets one and
  Martinez puts through his own net" fails when both goals came in the
  same half. "Came from behind" passes only when half_time_comeback is
  true;
- E6: ties itself to when it's read, since people read these days later
  (e.g. "today", "tonight", "yesterday", "last night", "this weekend",
  "this morning", "last week", "recently", "back in September");
- E7: contradicts the match data, even as an opinion;
- E8: names a player whose "under_18" is true, unless the comment is STAT;
- E9: says what position a player plays (e.g. "up top", "at the back"),
  since positions aren't in the match data;
- E10: criticises or blames a named player, in any type of comment, for
  anything other than their red card, own goal or missed penalty. Saves,
  goals conceded and how busy a player was are never grounds, even by
  implication: "Roefs made just one save despite us shipping five goals"
  fails. Stating a player's events neutrally ("Roefs made one save")
  passes.
- E11: talks about a named player, in the comment or its note, as if they
  played for the other team. Check the player's team in the facts. One of
  our players can't be someone "we" fear or who hurt, beat or punished us:
  "Lerma showed why we fear him" fails when Lerma plays for us. One of
  their players can't be "ours", or someone who played for us: "our
  Martinez" fails when Martinez plays for them. Their player's own goal
  counting for us is not a failure.

Rules by type — check only the rules for the comment's declared type:
- STAT:
  - S1: fail if any specific claim isn't in the match data above, including
    "players" and "hooks", even if it might be true (an assist, a league
    position, a run of form). A short reaction that makes no claim of its
    own ("Mad game.", "Football.") is not a claim.
  - S2: fail if any number, in digits or in words ("one", "nil", "three"),
    doesn't match the match data.
- HOT_TAKE (positive or enthusiastic opinions pass, however strong; strong
  criticism of performance alone is not a failure):
  - H1: fail if the comment or its note contains any number at all, in
    digits or in words ("one", "three", "six-goal"), even one that
    matches the match data: numbers belong in STAT lines. "One" in an
    idiom such as "one of the best" or "no one" isn't a number.
  - H2: fail if it implies, in any phrasing and even hedged as opinion,
    that the team, any player or staff lacked effort, were dishonest or
    cheated, if it comments on a player's character, private life, looks,
    nationality or injuries, or if it refers to anything off the pitch.
    "Couldn't be bothered" and "not at the races" (in any form, such as
    "nowhere near the races") always fail.
  - H3: fail if it criticises a named player without saying, in the text
    or the note, which of that player's events in "players" it's based on,
    if the criticism goes beyond that event (e.g. "anonymous all game"), or
    if it criticises a player for anything other than a red card, an own
    goal or a missed penalty. Saves, goals conceded and how busy a player
    was are never grounds: "Roefs barely got tested and still let five in"
    fails.
- BANTER:
  - B1: fail if the comment or its note contains any number or scoreline
    of any kind, in digits or in words (including "one" or "nil").
  - B2: fail if it states a specific date or a named past incident.
  - B3: fail if it says anything about what happened on the pitch in past
    meetings, including style of play (e.g. "we never do a routine 1-0",
    "every fixture against City turns into a basketball score", "always
    try and rough us up", "we always struggle there"). Saying how a
    fixture, an atmosphere or a club's fans feel or behave is fine (e.g.
    "always feels like a proper occasion", "their fans never need an
    excuse").
  - B4: fail if it names a player.
  - B5: fail if it mentions this match's day, date or result (e.g. "a
    Sunday kick-off", "that result doesn't really count").
  - B6: fail if it uses a club song, chant, nickname or tradition that
    fans of both clubs wouldn't know, or one that's made up. A club's
    common nickname or its best-known terrace song passes.
  - B7: fail if it mocks anything beyond football: a town, city, region or
    accent, money, or any tragedy or disaster. Friendly digs at a club,
    its fans, its songs or its nickname pass.

For each comment in turn, go through E1 to E11, then each rule for that
comment's declared type, in order. Give each rule "pass" or "fail"; add a
short reason only for a rule that fails, as "fail: <short reason>".

If you can't tell whether a comment breaks a rule, or it's a borderline
call, give that rule "unsure: <short reason>" instead. A comment with an
unsure rule is never shown to anyone, so it costs nothing: never guess
"pass". Only give "pass" when you're sure the comment keeps the rule.

A comment's overall result is "fail" if any of its rules failed, otherwise
"unsure" if any rule was unsure, otherwise "pass".

Return only this JSON, with one entry per comment, keyed by its number, and
in each one entry per rule you checked:
{"1": {"rules": {"E1": "pass", "E2": "pass", ..., "E11": "pass", "<type rule>": "pass"}, "result": "pass" | "fail" | "unsure", "reason": "<short reason if it failed or was unsure, otherwise empty>"}, "2": {...}, ...}
