You are checking one football comment against a match's real data before it
ships to a user. Reject anything that could embarrass the user if challenged,
using the rule for its declared type.

Match data:
{{match_data_json}}

Comment to check:
{{comment_json}}

The match data above is everything that is known about this match. It has
no information about who played, who scored, goal times, cards, penalties,
substitutions or any other incident.

Rules for every type — fail the comment if it:
- names or clearly identifies any individual (player, manager, coach,
  official), including stand-ins like "their keeper" or "the new signing";
- describes a specific incident that isn't in the match data (a goal by a
  particular player or at a particular time, a penalty, a card, a VAR call,
  a save, an injury);
- claims anything about league position, titles, the table, form, or other
  matches this season or in past seasons (e.g. "champions elect",
  "mid-table", "the recurring issue all season"). A clearly personal
  superlative opinion, like "worst first half I've seen from us all
  season", is not a failure;
- names a venue, stadium or ground;
- claims anything about the order or timing of goals beyond what the
  half-time and full-time scores show (e.g. "while we were already up",
  "late winner"). "Came from behind" passes only when half_time_comeback
  is true;
- contradicts the match data, even as an opinion.

Rules by type:
- STAT: every specific claim must appear in the match data above. Fail if
  any claim isn't in the data, even if it might be true (a scorer, a league
  position, a run of form).
- HOT_TAKE: positive/enthusiastic opinions pass, however strong, provided
  they meet the rules for every type. For negative/critical opinions, also
  fail if it implies (in any phrasing, including hedged as opinion) that
  the team, its players or staff lacked effort, were dishonest or cheated,
  or references anything off the pitch. Lack-of-effort phrasing includes
  "couldn't be bothered" and "not at the races" (in any form, such as
  "nowhere near the races"): a comment using either always fails. Strong
  performance criticism alone is not a failure.
- BANTER: fail if it contains any number or scoreline of any kind (in
  digits or in words, including "one" or "nil"), states a specific date or
  named past incident, or claims anything about how past meetings between
  the teams went (e.g. "we never do a routine 1-0", "every fixture against
  City turns into a basketball score"), since none of that can be verified
  against real data.

Return JSON: { "result": "pass" | "fail", "reason": "<why, if failed>" }.
