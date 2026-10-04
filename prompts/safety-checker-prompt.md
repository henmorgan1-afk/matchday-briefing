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
- contradicts the match data, even as an opinion.

Rules by type:
- STAT: every specific claim must appear in the match data above. Fail if
  any claim isn't in the data, even if it might be true (a scorer, a league
  position, a run of form).
- HOT_TAKE: positive/enthusiastic opinions pass, however strong, provided
  they meet the rules for every type. For negative/critical opinions, also
  fail if it implies (in any phrasing, including hedged as opinion) that
  the team, its players or staff lacked effort, were dishonest or cheated,
  or references anything off the pitch. Strong performance criticism alone
  is not a failure.
- BANTER: fail if it states a specific date, score, or named past incident,
  since none of that can be verified against real data.

Return JSON: { "result": "pass" | "fail", "reason": "<why, if failed>" }.
