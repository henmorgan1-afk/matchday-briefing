// The plain-English fact sheet (SPEC.md §3.5, Revision 21 idea 1): buildMatchData's output written
// as short sentences, for the {{fact_sheet}} placeholder in the generation and checker prompts. Team
// names are used throughout, never "perspective" or "opponent", and each team's goals and the match
// total get their own sentences, so they can't be mixed up. Code writes facts only: it never writes
// a line or a note.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const goals = (n) => plural(n, 'goal');

// "a morning", "an afternoon" or "an evening", from a "15:00" kickoff time in UK time: before 12:00 is
// morning, before 17:00 afternoon, and 17:00 or later evening.
function partOfDay(kickoffTime) {
  const hour = Number(kickoffTime.slice(0, 2));
  return hour < 12 ? 'a morning' : hour < 17 ? 'an afternoon' : 'an evening';
}

// "a", "a and b", "a, b and c"
function listing(parts) {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// One player's events, in the order the match data lists them.
function eventPhrases(events, scoredFor) {
  const phrases = [];
  if (events.goal) phrases.push(`scored ${goals(events.goal)}`);
  if (events.own_goal) phrases.push(`scored ${plural(events.own_goal, 'own goal')}, which counted for ${scoredFor}`);
  if (events.red_card) phrases.push('was sent off');
  if (events.pen_missed) phrases.push(`missed ${plural(events.pen_missed, 'penalty', 'penalties')}`);
  if (events.pen_saved) phrases.push(`saved ${plural(events.pen_saved, 'penalty', 'penalties')}`);
  if (events.saves) phrases.push(`made ${plural(events.saves, 'save')}`);
  return phrases;
}

// The fact sheet for one perspective's match data, one sentence or short group per line.
function buildFactSheet(md) {
  const us = md.perspective_team;
  const them = md.opponent;
  const home = md.perspective_side === 'home' ? us : them;
  const away = md.perspective_side === 'home' ? them : us;
  // A { perspective, opponent } pair as [home's, away's].
  const homeAway = (pair) => (md.perspective_side === 'home' ? [pair.perspective, pair.opponent] : [pair.opponent, pair.perspective]);
  const scored = (pair) => {
    const [h, a] = homeAway(pair);
    return `${home} scored ${goals(h)} and ${away} scored ${goals(a)}`;
  };
  const lines = [];

  lines.push(`"We", "us" and "our" mean ${us}. "They", "them" and "their" mean ${them}.`);
  lines.push(`${home} were at home and ${away} were away.`);

  const [ftHome, ftAway] = homeAway(md.full_time);
  lines.push(`Final score: ${home} ${ftHome}, ${away} ${ftAway}.`);
  lines.push(`${scored(md.full_time)}.`);
  lines.push(`There ${md.total_goals === 1 ? 'was' : 'were'} ${goals(md.total_goals)} in the match in total.`);

  if (md.result === 'drew') {
    lines.push(`The match was a draw, so ${us} and ${them} got 1 point each.`);
  } else {
    const [winner, loser] = md.result === 'won' ? [us, them] : [them, us];
    lines.push(`${winner} won by ${goals(md.winning_margin)}, so ${winner} got 3 points and ${loser} got 0.`);
  }

  if (md.half_time) {
    const [htHome, htAway] = homeAway(md.half_time);
    lines.push(`Half-time score: ${home} ${htHome}, ${away} ${htAway}.`);
    lines.push(`In the first half, ${scored(md.first_half_goals)}.`);
    lines.push(`In the second half, ${scored(md.second_half_goals)}.`);
  } else {
    lines.push("The half-time score isn't known, so nobody knows how many goals came in either half.");
  }

  const cleanSheets = [];
  if (md.full_time.opponent === 0) cleanSheets.push(`${us} kept a clean sheet: ${them} didn't score.`);
  if (md.full_time.perspective === 0) cleanSheets.push(`${them} kept a clean sheet: ${us} didn't score.`);
  lines.push(...(cleanSheets.length ? cleanSheets : ['Neither team kept a clean sheet.']));

  if (md.half_time) {
    const theyCameBack = md.half_time_state === 'leading' && md.result !== 'won';
    if (md.half_time_comeback) lines.push(`${us} came from behind: ${us} were losing at half-time and didn't lose.`);
    else if (theyCameBack) lines.push(`${them} came from behind: ${them} were losing at half-time and didn't lose.`);
    else lines.push('Neither team came from behind after losing at half-time.');
  } else {
    lines.push('Whether either team came from behind isn\'t known.');
  }

  const matchday = md.matchday == null ? '' : `, matchday ${md.matchday}`;
  lines.push(`The match was played on ${md.kickoff_date}, in the ${md.competition}${matchday}.`);
  if (md.matchday == null) lines.push("The matchday isn't known.");
  // Revision 24: the go-live test had "night" for 14:00 and 15:00 kickoffs.
  lines.push(`It kicked off at ${md.kickoff_time} UK time, so it was ${partOfDay(md.kickoff_time)} match.`);

  if (!md.players) {
    lines.push("Who scored isn't known, and nor is anything else any player did, so no player can be named.");
  } else {
    const groups = [[md.players.our_players, them], [md.players.their_players, us]];
    for (const [players, otherTeam] of groups) {
      for (const p of players) {
        const u18 = p.under_18 ? ', is under 18,' : '';
        lines.push(`${p.name} plays for ${p.team}${u18} and ${listing(eventPhrases(p.events, otherTeam))}.`);
      }
    }
    lines.push('No other player scored, scored an own goal, was sent off, missed or saved a penalty, or made a save.');
  }

  lines.push('Nothing else is known about this match: not when any goal went in, who made assists, yellow cards, substitutions, or what position anyone plays.');
  return lines.join('\n');
}

module.exports = { buildFactSheet };
