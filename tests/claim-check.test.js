// Idea 2: the claim check's comparison with the match data (SPEC.md §3.1, Revision 21), on 560595-style
// data (Chelsea 5, Bournemouth 1). The claim model is stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockNetwork, side, usage } = require('./helpers');
const { claimCheck, compareLine, readClaimResults, claimPrompt } = require('../scripts/claim-check');

blockNetwork();

const home = side('home').matchData; // Chelsea
const away = side('away').matchData; // Bournemouth
const claim = (kind, team, value, extra = {}) => ({ kind, team, player: null, period: null, value, quote: 'q', ...extra });

test('a claim that Chelsea scored 6 fails, from either side', () => {
  // Bournemouth's round-3 line: "Chelsea's attack was a relentless six-goal blitz."
  const fromBournemouth = compareLine({ claims: [claim('goals_scored', 'them', 6, { period: 'full_time' }), claim('opinion', null, null)] }, away, 'HOT_TAKE');
  assert.equal(fromBournemouth.result, 'fail');
  assert.match(fromBournemouth.reason, /says 6, the match data says 5/);
  const fromChelsea = compareLine({ claims: [claim('goals_scored', 'us', 6)] }, home, 'STAT');
  assert.equal(fromChelsea.result, 'fail');
  // As goals conceded, from Bournemouth's side: they let in 5, not 6.
  assert.equal(compareLine({ claims: [claim('goals_conceded', 'us', 6)] }, away, 'STAT').result, 'fail');
});

test('correct claims pass and are counted', () => {
  const r = compareLine({
    claims: [
      claim('score', 'match', { us: 5, them: 1 }),
      claim('result', 'us', 'won'),
      claim('home_or_away', 'us', 'home'),
      claim('total_goals', 'match', 6),
      claim('goals_scored', 'us', 2, { period: 'first_half' }),
      claim('half_time_score', 'match', { us: 2, them: 0 }),
      claim('goals_scored', 'us', 2, { player: 'Henderson' }),
      claim('saves', 'us', 3, { player: 'Martinez' }),
      claim('points', 'them', 0),
      claim('clean_sheet', 'us', false),
      claim('winning_margin', 'us', 4),
      claim('matchday', 'match', 6),
      claim('date', 'match', 'Saturday'),
      claim('came_from_behind', 'them', false),
    ],
  }, home, 'STAT');
  assert.equal(r.result, 'pass', r.reason);
  assert.equal(r.checked, 14);
  // The same score, as Bournemouth's lines would report it.
  assert.equal(compareLine({ claims: [claim('score', 'match', { us: 1, them: 5 }), claim('result', 'us', 'lost')] }, away, 'STAT').result, 'pass');
});

test('a player put on the wrong team fails ("our Martinez" from Bournemouth)', () => {
  const r = compareLine({ claims: [claim('saves', 'us', 3, { player: 'Martinez' })] }, away, 'STAT');
  assert.equal(r.result, 'fail');
  assert.match(r.reason, /plays for Chelsea/);
  // A line that doesn't say which team ("Martinez made three saves") isn't checked for one.
  assert.equal(compareLine({ claims: [claim('saves', null, 3, { player: 'Martinez' })] }, away, 'STAT').result, 'pass');
});

test('a count with no number ("his saves") is checked as at least one', () => {
  assert.equal(compareLine({ claims: [claim('saves', null, null, { player: 'Martinez' })] }, home, 'HOT_TAKE').result, 'pass');
  assert.equal(compareLine({ claims: [claim('goals_conceded', 'them', null)] }, home, 'HOT_TAKE').result, 'pass');
  assert.equal(compareLine({ claims: [claim('red_card', 'us', null)] }, home, 'HOT_TAKE').result, 'fail');
  assert.equal(compareLine({ claims: [claim('goals_scored', 'us', null, { player: 'Martinez' })] }, home, 'HOT_TAKE').result, 'fail');
});

test('unverifiable fails; culture and opinion pass without counting', () => {
  const unverifiable = compareLine({ claims: [claim('unverifiable', null, null, { quote: 'a late winner' })] }, home, 'HOT_TAKE');
  assert.equal(unverifiable.result, 'fail');
  assert.match(unverifiable.reason, /a late winner/);
  const culture = compareLine({ claims: [claim('culture', null, null, { quote: 'the Cherries' }), claim('opinion', null, null)] }, home, 'BANTER');
  assert.deepEqual([culture.result, culture.checked], ['pass', 0]);
});

test("values code can't compare fail", () => {
  for (const c of [
    claim('goals_scored', 'us', 'loads'),
    claim('shots', 'us', 9),
    claim('goals_scored', 'us', 1, { player: 'Haaland' }),
    claim('goals_scored', 'us', 1, { player: 'Henderson', period: 'second_half' }),
    claim('date', 'match', 'Bonfire Night'),
  ]) assert.equal(compareLine({ claims: [c] }, home, 'HOT_TAKE').result, 'fail', JSON.stringify(c));
});

test('a STAT line with no factual claim fails, a HOT_TAKE with none passes', () => {
  assert.equal(compareLine({ claims: [claim('opinion', null, null)] }, home, 'STAT').result, 'fail');
  assert.equal(compareLine({ claims: [] }, home, 'HOT_TAKE').result, 'pass');
});

test('a missing or unreadable extraction fails closed', () => {
  const lines = [{ type: 'STAT', text: 'a', note: 'n' }, { type: 'HOT_TAKE', text: 'b', note: 'n' }, { type: 'HOT_TAKE', text: 'c', note: 'n' }];
  const r = readClaimResults(JSON.stringify({ 1: { claims: [claim('result', 'us', 'won')] }, 3: { claims: 'none' } }), 'stop', home, lines);
  assert.deepEqual(r.map((x) => x.result), ['pass', 'fail', 'fail']);
  assert.match(r[1].reason, /no claim list for line 2/);
  assert.match(r[2].reason, /no readable claim list/);
  assert.ok(readClaimResults('not json at all', 'length', home, lines).every((x) => x.result === 'fail'));
  assert.ok(readClaimResults('{"1": {"claims": []}}', 'refusal', home, lines).every((x) => x.result === 'fail'));
});

test('the claim model sees names, teams and lines, never the scores or counts', async () => {
  const lines = [{ type: 'HOT_TAKE', text: "Chelsea's attack was a relentless six-goal blitz.", note: 'Strong take.' }];
  const prompt = claimPrompt(away, lines);
  assert.match(prompt, /"we", "us", "our" and "ours" mean Bournemouth/);
  assert.match(prompt, /- Martinez \(Chelsea\)/);
  assert.doesNotMatch(prompt, /\b5\b|"full_time": \{|"saves": 3|Final score|"events"/);
  let seenModel;
  const out = await claimCheck(away, lines, {
    completeFn: async (p, { model }) => {
      seenModel = model;
      return { text: JSON.stringify({ 1: { claims: [claim('goals_scored', 'them', 6)] } }), stopReason: 'stop', usage: usage() };
    },
  });
  assert.equal(seenModel, '@cf/zai-org/glm-4.7-flash');
  assert.equal(out.results[0].result, 'fail');
});
