You are reading short football comments written for a {{perspective_team_name}}
fan about a match against {{opponent_team_name}}. Your job is to list every
factual claim each comment and its note makes. Don't judge whether a claim is
true: you haven't been given the score or any counts, and every claim you list
will be checked separately. Report what the comment says, nothing more.

Who is who:
- "we", "us", "our" and "ours" mean {{perspective_team_name}}.
- "they", "them", "their" and "theirs" mean {{opponent_team_name}}, unless the
  comment plainly means someone else.
- The only players a comment can name are these, each with the team they play
  for:
{{players_list}}

Comments to read, keyed by number, each with its type, text and note:
{{comments_json}}

Read each comment's text and note together, and list every claim in them.

1. A claim about a fact of this match gets one entry with these fields:
   - "kind": one of goals_scored, goals_conceded, total_goals,
     winning_margin, saves, red_card, own_goal, penalty_missed,
     penalty_saved, score, half_time_score, result, points, clean_sheet,
     home_or_away, came_from_behind, date, matchday.
   - "team": "us", "them" or "match" (both teams together). For a player's
     claim, the team the comment says the player is on.
   - "player": the player's name exactly as listed above, or null.
   - "period": "full_time", "first_half" or "second_half" for a claim about
     goals, a score or a margin; null for anything else. "At the break" and
     "at half-time" mean first_half.
   - "value": what the comment says, with every number as digits:
     - goals_scored, goals_conceded, total_goals, winning_margin, saves,
       red_card, own_goal, penalty_missed, penalty_saved, points and
       matchday: a whole number. A brace is 2, a hat-trick 3, a lone goal 1,
       "sent off" is a red_card of 1, and "two up" is a winning_margin of 2.
     - score and half_time_score: {"us": <our goals>, "them": <their goals>},
       whichever order the comment writes them in.
     - result: "won", "drew" or "lost", for the team in "team".
     - clean_sheet and came_from_behind: true or false, for the team in
       "team".
     - home_or_away: "home" or "away", for the team in "team".
     - date: the day or date as the comment writes it, such as "Saturday".
   - "quote": the words that make the claim.
   For goals_conceded, "team" is the team that let the goals in. For
   own_goal, "team" is the team of the player who put the ball into his own
   net. For winning_margin, "team" is the team that was ahead.

2. A factual claim that the match details could never show gets one entry
   with "kind": "unverifiable" and a "quote". For example: an assist; when or
   in what order goals went in, beyond which half; how a goal was scored or
   what it looked like; a penalty goal; what position a player plays; a
   yellow card; a substitution; an injury; a venue, stadium or ground name;
   the league table; form; or any other match.

3. Club culture, such as a nickname, a song or how fans behave, gets one
   entry with "kind": "culture" and a "quote".

4. An opinion or a reaction ("a shocker", "brilliant", "our defence looked
   like a sieve") gets one entry with "kind": "opinion" and a "quote". When
   an opinion also states a fact ("a relentless six-goal blitz"), list the
   fact as its own entry too.

Return only this JSON, with one entry per comment, keyed by its number:
{"1": {"claims": [{"kind": "...", "team": "...", "player": null, "period": null, "value": ..., "quote": "..."}, ...]}, "2": {"claims": []}, ...}
