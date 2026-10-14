// Idea 1: the plain-English fact sheet (SPEC.md §3.5, Revision 21).
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockNetwork, side, CHELSEA, BOURNEMOUTH } = require('./helpers');
const { buildMatchData } = require('../scripts/lib/match-data');
const { buildFactSheet } = require('../scripts/lib/fact-sheet');

blockNetwork();

test('560595 from Bournemouth: team names, separate goal sentences, half-time, players', () => {
  const sheet = buildFactSheet(side('away').matchData);
  for (const sentence of [
    '"We", "us" and "our" mean Bournemouth. "They", "them" and "their" mean Chelsea.',
    'Chelsea were at home and Bournemouth were away.',
    'Final score: Chelsea 5, Bournemouth 1.',
    'Chelsea scored 5 goals and Bournemouth scored 1 goal.',
    'There were 6 goals in the match in total.',
    'Chelsea won by 4 goals, so Chelsea got 3 points and Bournemouth got 0.',
    'Half-time score: Chelsea 2, Bournemouth 0.',
    'In the first half, Chelsea scored 2 goals and Bournemouth scored 0 goals.',
    'In the second half, Chelsea scored 3 goals and Bournemouth scored 1 goal.',
    'Neither team kept a clean sheet.',
    'Neither team came from behind after losing at half-time.',
    'The match was played on Sat 10 Oct 2026, in the Premier League, matchday 6.',
    'Martinez plays for Chelsea and made 3 saves.',
    'Evanilson plays for Bournemouth and scored 1 goal.',
  ]) assert.ok(sheet.includes(sentence), `missing: ${sentence}\n---\n${sheet}`);
  assert.match(sheet, /Nothing else is known about this match: not when any goal went in, who made assists, yellow cards, substitutions, or what position anyone plays\.$/);
  assert.doesNotMatch(sheet, /perspective|opponent/i);
});

test('own goal says which team it counted for; under-18 player marked; half-time unknown', () => {
  const fulham = { id: '63', short_name: 'Fulham', tla: 'FUL', slug: 'fulham' };
  const united = { id: '66', short_name: 'Man United', tla: 'MUN', slug: 'man-united' };
  const match = {
    id: '999583', competition: 'PL', matchday: null, home_team_id: '63', away_team_id: '66',
    home_score: 1, away_score: 1, home_ht_score: null, away_ht_score: null, kickoff_at: '2026-09-20T13:00:00Z',
  };
  const players = new Map([
    [10, { fpl_id: 10, web_name: 'Martinez', first_name: 'Lisandro', second_name: 'Martínez', known_name: null, birth_date: '1998-01-18' }],
    [11, { fpl_id: 11, web_name: 'Cunha', first_name: 'Matheus', second_name: 'Cunha', known_name: null, birth_date: '1999-05-27' }],
    [12, { fpl_id: 12, web_name: 'Kid', first_name: 'Young', second_name: 'Kid', known_name: null, birth_date: '2010-03-01' }],
  ]);
  const events = [
    { fpl_id: 10, team_id: '66', event: 'own_goal', count: 1 },
    { fpl_id: 11, team_id: '66', event: 'goal', count: 1 },
    { fpl_id: 12, team_id: '63', event: 'saves', count: 2 },
  ];
  const sheet = buildFactSheet(buildMatchData(match, fulham, united, { events, players }));
  assert.ok(sheet.includes('Martinez plays for Man United and scored 1 own goal, which counted for Fulham.'), sheet);
  assert.ok(sheet.includes('Kid plays for Fulham, is under 18, and made 2 saves.'), sheet);
  assert.ok(sheet.includes("The half-time score isn't known, so nobody knows how many goals came in either half."), sheet);
  assert.ok(sheet.includes("Whether either team came from behind isn't known."), sheet);
  assert.ok(sheet.includes('The match was a draw, so Fulham and Man United got 1 point each.'), sheet);
  assert.ok(sheet.includes("The matchday isn't known."), sheet);
  assert.doesNotMatch(sheet, /Half-time score:/);
});

test('clean sheet and coming from behind are named by team', () => {
  const match = {
    id: '1', competition: 'PL', matchday: 3, home_team_id: '61', away_team_id: '1044',
    home_score: 0, away_score: 2, home_ht_score: 0, away_ht_score: 0, kickoff_at: '2026-09-01T14:00:00Z',
  };
  const sheet = buildFactSheet(buildMatchData(match, CHELSEA, BOURNEMOUTH, null));
  assert.ok(sheet.includes("Bournemouth kept a clean sheet: Chelsea didn't score."), sheet);
  assert.ok(sheet.includes("Who scored isn't known"), sheet);
  const comeback = { ...match, home_score: 2, away_score: 1, home_ht_score: 0, away_ht_score: 1 };
  assert.ok(buildFactSheet(buildMatchData(comeback, BOURNEMOUTH, CHELSEA, null)).includes('Chelsea came from behind: Chelsea were losing at half-time and didn\'t lose.'));
});
