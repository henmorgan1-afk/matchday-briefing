// Idea 3: numbers only in STAT (SPEC.md §3.3, §9, Revision 21), plus the existing gate on the fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockNetwork, side, chelseaLines } = require('./helpers');
const { codeGateProblems } = require('../scripts/lib/code-gate');

blockNetwork();

const gate = (line, which = 'home') => {
  const { matchData, names } = side(which);
  return codeGateProblems(line, matchData, names);
};

test('"Chelsea\'s attack was a relentless six-goal blitz" fails as a HOT_TAKE (560595, Bournemouth)', () => {
  const problems = gate({ type: 'HOT_TAKE', text: "Chelsea's attack was a relentless six-goal blitz.", note: 'Strong take. Not everyone will agree.' }, 'away');
  assert.equal(problems.length, 1, problems.join('; '));
  assert.match(problems[0], /HOT_TAKE line contains a number, "six"/);
  // The non-breaking hyphen the model wrote in round 3 is caught too.
  assert.ok(gate({ type: 'HOT_TAKE', text: 'Chelsea’s attack was a relentless six‑goal blitz.', note: 'Strong take.' }, 'away').length);
});

test('"one of the best" passes in a HOT_TAKE (the existing "one" idiom exception)', () => {
  assert.deepEqual(gate({ type: 'HOT_TAKE', text: 'Rogers looked like one of the best on the pitch.', note: 'Strong take on Rogers, who scored.' }), []);
});

test('a number in a HOT_TAKE note fails', () => {
  const problems = gate({ type: 'HOT_TAKE', text: 'Our attack was unplayable. Pure joy.', note: 'Strong take based on five goals.' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /HOT_TAKE note contains a number, "five"/);
});

test('a number in a BANTER note fails, as does one in its line', () => {
  const note = gate({ type: 'BANTER', text: 'Cherries fans always bring the noise. Shame about the rest.', note: 'General chat. The Cherries is one of two nicknames.' });
  assert.ok(note.some((p) => /BANTER note contains a number, "two"/.test(p)), note.join('; '));
  const line = gate({ type: 'BANTER', text: 'Two sets of fans, one song.', note: 'General chat, not about this match.' });
  assert.ok(line.some((p) => /BANTER line contains a number/.test(p)), line.join('; '));
});

test('a correct STAT passes, and a STAT number not in the match data still fails', () => {
  assert.deepEqual(gate({ type: 'STAT', text: 'Won 5-1 at home. Lovely stuff.', note: 'From the final score, 5-1.' }), []);
  assert.deepEqual(gate({ type: 'STAT', text: 'Six goals in the match. Mental.', note: 'From the final score.' }), []);
  assert.match(gate({ type: 'STAT', text: 'Seven goals in the match. Mental.', note: 'From the final score.' })[0], /STAT line uses "seven"/);
});

test('every fixture line passes the gate', () => {
  for (const line of chelseaLines()) assert.deepEqual(gate(line), [], line.text);
});
