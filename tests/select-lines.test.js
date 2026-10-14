// Idea 5: keep the best 4-5 (SPEC.md §3.1, Revision 21).
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockNetwork } = require('./helpers');
const { selectLines } = require('../scripts/lib/select-lines');
const { finishAttempt } = require('../scripts/run-pipeline');

blockNetwork();

const line = (type, claims, text = `${type} ${claims} ${Math.random()}`) => ({ type, claims_checked: claims, text });

test('7 publishable lines become 5, with at least 1 STAT and 1 HOT_TAKE', () => {
  const lines = [line('STAT', 2), line('STAT', 1), line('STAT', 3), line('BANTER', 0), line('HOT_TAKE', 0), line('HOT_TAKE', 1), line('HOT_TAKE', 0)];
  const chosen = selectLines(lines, 5);
  assert.equal(chosen.length, 5);
  assert.deepEqual(chosen.map((l) => l.type), ['HOT_TAKE', 'STAT', 'BANTER', 'HOT_TAKE', 'STAT']);
});

test('fewer checked claims are preferred within a type, then the order written', () => {
  const lines = [line('STAT', 3, 'a'), line('STAT', 1, 'b'), line('STAT', 1, 'c'), line('HOT_TAKE', 2, 'd'), line('HOT_TAKE', 0, 'e'), line('HOT_TAKE', 0, 'f')];
  const chosen = selectLines(lines, 4).map((l) => l.text);
  assert.deepEqual(chosen, ['e', 'b', 'f', 'c']);
});

test('only HOT_TAKEs passing gives 5 HOT_TAKEs', () => {
  const lines = Array.from({ length: 6 }, (_, i) => line('HOT_TAKE', 0, `h${i}`));
  const chosen = selectLines(lines, 5);
  assert.equal(chosen.length, 5);
  assert.ok(chosen.every((l) => l.type === 'HOT_TAKE'));
});

test('a second attempt fills only the places left and keeps the spread', () => {
  const lines = [line('HOT_TAKE', 0, 'h1'), line('HOT_TAKE', 0, 'h2'), line('STAT', 1, 's1'), line('BANTER', 0, 'b1')];
  // Already live: 2 HOT_TAKE and 1 STAT, so 2 places, and BANTER and STAT are behind.
  const chosen = selectLines(lines, 2, ['HOT_TAKE', 'HOT_TAKE', 'STAT']).map((l) => l.text);
  assert.deepEqual(chosen, ['b1', 's1']);
  assert.deepEqual(selectLines(lines, 0), []);
  assert.equal(selectLines(lines, 5).length, 4);
});

test('finishAttempt marks the rest not_selected and only chosen lines claim their opening words', () => {
  const steps = () => ({ variety: 'not reached', selection: 'not reached' });
  const candidates = [
    { type: 'STAT', text: 'Won five one at home.', result: 'pass', claims_checked: 2, steps: steps() },
    { type: 'STAT', text: 'Six goals in total. Mental.', result: 'pass', claims_checked: 1, steps: steps() },
    { type: 'STAT', text: 'Henderson scored twice. Greedy.', result: 'pass', claims_checked: 1, steps: steps() },
    { type: 'BANTER', text: 'Cherries fans bring noise.', result: 'pass', claims_checked: 0, steps: steps() },
    { type: 'HOT_TAKE', text: 'Our attack was unplayable.', result: 'pass', claims_checked: 0, steps: steps() },
    { type: 'HOT_TAKE', text: 'Our attack was magnificent.', result: 'pass', claims_checked: 0, steps: steps() },
    { type: 'HOT_TAKE', text: 'Second half was a joy.', result: 'pass', claims_checked: 0, steps: steps() },
    { type: 'HOT_TAKE', text: 'Defending was a sieve.', result: 'fail', failed_by: 'checker', steps: steps() },
  ];
  const openings = new Set(['six goals in']); // the other side already has a line opening like this
  const { publishable, chosen } = finishAttempt(candidates, { liveKeys: new Set(), openings, liveTypes: [], places: 5 });
  assert.equal(candidates[1].failed_by, 'variety');
  assert.equal(candidates[5].failed_by, 'variety'); // "our attack was" twice on one side
  assert.equal(publishable.length, 5);
  assert.equal(chosen.length, 5);
  assert.ok(candidates.filter((c) => c.failed_by === 'not_selected').length === 0);
  // With only 3 places, two publishable lines are left out.
  const again = candidates.map((c) => ({ ...c, result: c.failed_by === 'checker' ? 'fail' : 'pass', failed_by: c.failed_by === 'checker' ? 'checker' : undefined, published: undefined, steps: steps() }));
  const r = finishAttempt(again, { liveKeys: new Set(), openings: new Set(), liveTypes: [], places: 3 });
  assert.equal(r.chosen.length, 3);
  const left = again.filter((c) => c.failed_by === 'not_selected');
  assert.equal(left.length, 3); // 7 passing, minus one variety drop, minus 3 chosen
  assert.ok(left.every((c) => c.published === false && c.steps.selection === 'not chosen'));
  assert.deepEqual(r.chosen.map((c) => c.type).sort(), ['BANTER', 'HOT_TAKE', 'STAT']);
});
