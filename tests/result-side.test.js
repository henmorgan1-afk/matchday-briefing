// Revision 25: the code gate's result-word and wrong-side rules, and "typical" as an other-match word,
// on the real lines from the go-live test and Revision 24's sanity runs. No model, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockNetwork, side: chelseaSide } = require('./helpers');
const { buildMatchData, listPlayers } = require('../scripts/lib/match-data');
const { buildNameIndex, nameContext, codeGateProblems, resultAndSideProblems } = require('../scripts/lib/code-gate');

blockNetwork();

// One side of a match: `players` are [web_name, 'home' | 'away', { event: count }].
function side({ home, away, score, ht = [0, 0], players }, which) {
  const team = (name, id) => ({ id, short_name: name, tla: name.slice(0, 3).toUpperCase(), slug: name.toLowerCase() });
  const [h, a] = [team(home, '1'), team(away, '2')];
  const match = {
    id: '9', competition: 'PL', matchday: 6, home_team_id: '1', away_team_id: '2', home_score: score[0], away_score: score[1],
    home_ht_score: ht[0], away_ht_score: ht[1], kickoff_at: '2026-10-10T16:30:00Z', status: 'finished', player_data: 'ok',
  };
  const rows = players.map(([web], i) => ({ fpl_id: i + 1, web_name: web, first_name: web, second_name: web, known_name: null, birth_date: '1995-01-01' }));
  const events = players.flatMap(([, where, evs], i) => Object.entries(evs).map(([event, count]) => ({ fpl_id: i + 1, team_id: where === 'home' ? '1' : '2', event, count })));
  const pd = { events, players: new Map(rows.map((r) => [r.fpl_id, r])) };
  const [us, them] = which === 'home' ? [h, a] : [a, h];
  return { matchData: buildMatchData(match, us, them, pd), names: nameContext(buildNameIndex(rows), listPlayers(match, us, pd)) };
}

const M560600 = { home: 'Man United', away: 'Tottenham', score: [1, 1], players: [
  ['Lammens', 'home', { saves: 2 }], ['Mbeumo', 'home', { goal: 1 }], ['Bentancur', 'away', { red_card: 1 }],
  ['Kinsky', 'away', { saves: 3 }], ['Solanke', 'away', { goal: 1 }],
] };
const M560596 = { home: 'Crystal Palace', away: 'Nottingham', score: [3, 1], ht: [2, 1], players: [['Lerma', 'home', { goal: 1 }], ['Wood', 'away', { goal: 1 }]] };
const M560592 = { home: 'Sunderland', away: 'Brighton', score: [0, 2], players: [['Struijk', 'away', { red_card: 1 }], ['Welbeck', 'away', { goal: 2 }]] };
const M560583 = { home: 'Fulham', away: 'Man United', score: [1, 1], players: [
  ['Leno', 'home', { saves: 5 }], ['Cunha', 'away', { goal: 1 }], ['Lammens', 'away', { saves: 6 }], ['Martinez', 'away', { own_goal: 1 }],
] };

const problems = (s, text, note = 'Strong take. Not everyone will agree.') => resultAndSideProblems({ text, note }, s.matchData, s.names);
const gate = (s, type, text, note = 'Strong take. Not everyone will agree.') => codeGateProblems({ type, text, note }, s.matchData, s.names);

test('the three known errors fail the code gate', () => {
  const spurs = side(M560600, 'away');
  assert.match(gate(spurs, 'HOT_TAKE', "Kinsky's reflexes saved us from a bigger defeat.", 'Strong opinion, praising Kinsky for his saves').join('; '), /says "defeat", but the match was a draw/);
  const united = side(M560600, 'home');
  assert.match(gate(united, 'HOT_TAKE', "Bentancur's red card cost us a win. Unacceptable discipline.", 'Strong take; criticises Bentancur for his red card.').join('; '),
    /"cost us" ties Bentancur to the wrong side: Bentancur plays for Tottenham, so the red card helped Man United/);
  const palace = side(M560596, 'home');
  assert.match(gate(palace, 'HOT_TAKE', 'Lerma showed why we fear him. Absolutely dangerous.', 'Strong take, based on his goal.').join('; '),
    /"we fear" ties Lerma to the wrong side: Lerma plays for Crystal Palace, so the goal helped Crystal Palace/);
});

test('rule 2 passes the right-side lines from the brief', () => {
  const sunderland = side(M560592, 'home');
  assert.deepEqual(problems(sunderland, "Struijk's red was a gift for us. Lucky break."), []);
  assert.deepEqual(problems(sunderland, "Struijk's red card was a gift for us."), []);
  const fulham = side(M560583, 'home');
  assert.deepEqual(problems(fulham, "Martinez's own‑goal was a gift we didn't need."), []); // a non-breaking hyphen, as the model wrote it
  assert.deepEqual(problems(fulham, "Martinez's own goal was a gift we didn't need."), []);
});

test('rule 2: "bad for us" and "good for us" phrases, each way round', () => {
  const united = side(M560600, 'home');
  // Their player's goal or saves hurting us, and our player's goal or saves helping us, are right.
  for (const ok of [
    "Solanke's goal hurt us.", 'Kinsky kept us out.', 'Solanke was too good for us.', "Solanke's goal was a blow for us.",
    "Mbeumo's goal saved us.", 'Lammens kept us in it.', "Mbeumo's goal gave us a point.", "Bentancur's red card helped us.",
    "Bentancur's red card didn't cost us.", "Bentancur's red was a disaster for Spurs.",
  ]) assert.deepEqual(problems(united, ok), [], ok);
  for (const bad of ["Mbeumo's goal cost us.", 'Lammens punished us.', "Solanke's goal was a gift for us.", "Kinsky's saves helped us."]) {
    assert.ok(problems(united, bad).length >= 1, bad); // "a gift for us" trips both "gift" and "for us"
  }
  // Our player's own goal or red card is bad for us; theirs good for us.
  const mun = side(M560583, 'away');
  assert.deepEqual(problems(mun, "Martinez's own goal cost us. Absolutely unacceptable."), []);
  assert.ok(problems(mun, "Martinez's own goal was a gift for us.").length >= 1);
  // The event the sentence names is the one judged; the nearest player before the phrase is the one tied.
  const spurs = side(M560600, 'away');
  assert.deepEqual(problems(spurs, "Mbeumo scored, but Kinsky's reflexes saved us."), []);
  // The note is checked too.
  assert.match(problems(united, 'Discipline matters.', "Bentancur's red card hurt us.").join(), /^note "hurt us" ties Bentancur/);
});

test('rule 1: after a draw, win and loss words fail; hypotheticals and idioms pass', () => {
  const united = side(M560600, 'home');
  for (const bad of ['We lost the game.', 'A loss, really.', 'We were beaten.', 'Won it at the end.', 'A win is a win.', 'Victory, just about.', 'A defeat.']) {
    assert.ok(problems(united, bad).length >= 1, bad);
  }
  for (const ok of [
    'Could have won.', "Should've won that.", 'Deserved to win.', 'Nearly won it.', 'No defeat, at least.', 'A draw. Fine.', 'One point each after a draw.',
    'Win, lose or draw, the noise never stops.', 'We lost the plot for a bit.', 'Lost composure.', 'Won the ball back well.',
    'Lammens was the difference between a draw and a defeat.', 'Spurs think chanting can win matches.', 'Their divine right to win every time.',
    "Bentancur's red card cost us a win.", // a might-have-been; rule 2 is what fails this line
  ]) assert.deepEqual(problems(united, ok).filter((p) => !p.includes('ties')), [], ok);
});

test('rule 1: after a win or a loss, it depends whose result the word is about', () => {
  const chelsea = chelseaSide('home'); // won 5-1
  const bournemouth = chelseaSide('away'); // lost 1-5
  for (const bad of ['We lost.', 'A draw at home.', 'A defeat, somehow.', 'Drew 5-1.']) assert.equal(problems(chelsea, bad).length, 1, `Chelsea: ${bad}`);
  for (const ok of ['Won 5-1 at home.', 'Bournemouth lost heavily.', 'A heavy defeat for them.', 'Their defeat was deserved.', 'Level at half-time, a first-half draw.']) {
    assert.deepEqual(problems(chelsea, ok), [], `Chelsea: ${ok}`);
  }
  for (const bad of ['We won.', 'A draw away.', 'Big win for us.']) assert.equal(problems(bournemouth, bad).length, 1, `Bournemouth: ${bad}`);
  for (const ok of [
    'Chelsea won 5-1.', 'Lost 5-1 away.', 'Away at Chelsea, lost 5-1.', 'Final score 5-1 to them. Straight loss.',
    'A win for Chelsea.', 'Henderson scored twice. Still won.', 'Evanilson scored. Still lost.',
  ]) assert.deepEqual(problems(bournemouth, ok), [], `Bournemouth: ${ok}`);
  // Notes and every type.
  assert.match(gate(chelsea, 'STAT', 'Won 5-1 at home. Lovely.', 'From the final score: we lost.').join(), /note says "lost", but Chelsea won/);
  assert.match(gate(bournemouth, 'BANTER', 'Blues fans know we always win.', 'General chat, not about this match.').join(), /says "win", but Bournemouth lost/);
  // "they" is the other team, whose result was a win.
  assert.deepEqual(problems(bournemouth, 'Blues fans think they always win.'), []);
});

test('rule 3: "typical" compares with other matches in STAT and HOT_TAKE, not BANTER', () => {
  const united = side(M560600, 'home');
  assert.match(gate(united, 'STAT', 'Both sides scored in the second half. Typical.', 'From the half-time and final scores.').join(), /compares with other matches \(E3\), "Typical"/);
  assert.match(gate(united, 'HOT_TAKE', 'Typical us.').join(), /"Typical"/);
  assert.doesNotMatch(gate(united, 'BANTER', 'Spurs fans are typical Londoners at heart.', 'General chat, not about this match.').join(), /Typical|typical/);
});
