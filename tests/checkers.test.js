// Ideas 4 and 5: both checkers' verdicts, "unsure", failing closed, the Groq request plan and the
// Cloudflare fallback for the second checker (SPEC.md Revision 21). Every model call is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockNetwork, side, chelseaLines, usage } = require('./helpers');
const { readVerdicts, secondCheck, safetyCheck, checkerPrompt, planGroqBatches } = require('../scripts/safety-check');
const { secondCheckConfig } = require('../scripts/lib/second-checker');
const { MINUTE_TOKEN_LIMIT, MAX_COMPLETION_TOKENS } = require('../scripts/lib/groq-client');

blockNetwork();

const { matchData } = side('home');
const lines = chelseaLines();

test('"unsure" on any rule makes the line unsure, which never passes', () => {
  const v = readVerdicts(JSON.stringify({
    1: { rules: { E1: 'pass', E5: 'unsure: might imply goal order' }, result: 'pass', reason: '' },
    2: { rules: { E1: 'pass' }, result: 'unsure', reason: 'borderline' },
    3: { rules: { E1: 'fail: names a manager', E2: 'unsure: maybe' }, result: 'unsure', reason: '' },
    4: { rules: { E1: 'pass' }, result: 'pass', reason: '' },
  }), 'stop', 4);
  assert.deepEqual(v.map((x) => x.result), ['unsure', 'unsure', 'fail', 'pass']);
  assert.match(v[0].reason, /E5: might imply goal order/);
});

test('the checker prompt carries the fact sheet above the match data JSON', () => {
  const prompt = checkerPrompt(matchData, lines.slice(0, 2));
  const facts = prompt.indexOf('Final score: Chelsea 5, Bournemouth 1.');
  const json = prompt.indexOf('"full_time": {');
  assert.ok(facts > 0 && json > facts);
  assert.match(prompt, /unsure: <short reason>/);
});

test('the first checker fails closed on a missing verdict', async () => {
  const out = await safetyCheck(matchData, lines.slice(0, 3), {
    completeFn: async () => ({ text: JSON.stringify({ 1: { rules: { E1: 'pass' }, result: 'pass' }, 3: { rules: { E1: 'pass' }, result: 'pass' } }), stopReason: 'stop', usage: usage() }),
  });
  assert.deepEqual(out.verdicts.map((v) => v.result), ['pass', 'fail', 'pass']);
  assert.match(out.problem, /no readable verdict for line 2/);
});

// A fake Groq client: answers each request with `reply(prompt)` and records the requests.
function fakeGroq(reply) {
  const requests = [];
  return {
    requests,
    complete: async (prompt, opts) => {
      requests.push({ prompt, opts });
      return { text: reply(prompt, requests.length), stopReason: 'stop', usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 700 } };
    },
  };
}

test('second checker on Groq: unparseable or missing verdicts fail closed', async () => {
  const garbled = await secondCheck(matchData, lines.slice(0, 3), { groq: fakeGroq(() => 'I think they are all fine') });
  assert.deepEqual(garbled.verdicts.map((v) => v.result), ['fail', 'fail', 'fail']);
  const empty = await secondCheck(matchData, lines.slice(0, 2), { groq: fakeGroq(() => '') });
  assert.ok(empty.verdicts.every((v) => v.result === 'fail'));
  const missing = await secondCheck(matchData, lines.slice(0, 2), { groq: fakeGroq(() => JSON.stringify({ 1: { rules: { E1: 'pass' }, result: 'pass' } })) });
  assert.deepEqual(missing.verdicts.map((v) => v.result), ['pass', 'fail']);
  assert.match(missing.problem, /no readable verdict for line 2/);
});

test('second checker on Groq: every request fits the minute limit, splitting a side if needed', async () => {
  const groq = fakeGroq((prompt) => {
    const n = (prompt.match(/"(\d+)": \{\n {4}"type"/g) ?? []).length;
    return JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), { rules: { E1: 'pass' }, result: 'pass' }])));
  });
  const out = await secondCheck(matchData, lines, { groq });
  assert.equal(out.verdicts.length, 8);
  assert.ok(out.verdicts.every((v) => v.result === 'pass'));
  assert.equal(groq.requests.length, 2); // 8 lines go in two requests of 4, for the output limit
  for (const r of groq.requests) {
    assert.ok(r.opts.budgetTokens <= MINUTE_TOKEN_LIMIT, `budget ${r.opts.budgetTokens}`);
    assert.ok(r.opts.maxCompletionTokens <= MAX_COMPLETION_TOKENS, `max ${r.opts.maxCompletionTokens}`);
    assert.equal(r.opts.model, 'qwen/qwen3.8-27b');
  }
  // A prompt too big for one request is split in halves.
  const big = { ...matchData, padding: 'x'.repeat(9000) };
  const batches = planGroqBatches(big, lines);
  assert.ok(batches.length > 1);
  assert.equal(batches.reduce((n, b) => n + b.lines.length, 0), 8);
  for (const b of batches) assert.ok(b.input + b.maxCompletionTokens <= MINUTE_TOKEN_LIMIT);
});

test('the Cloudflare fallback for the second checker uses Gemma on the AI_PROVIDER and the same prompt', async () => {
  const config = secondCheckConfig('cloudflare');
  assert.equal(config.model, '@cf/google/gemma-4-26b-a4b-it');
  assert.equal(config.failedBy, 'second_checker');
  const seen = [];
  const out = await secondCheck(matchData, lines.slice(0, 2), {
    config,
    completeFn: async (prompt, { model }) => {
      seen.push({ prompt, model });
      return { text: JSON.stringify({ 1: { rules: { E1: 'pass' }, result: 'pass' }, 2: { rules: { H2: 'unsure: maybe effort' }, result: 'unsure' } }), stopReason: 'stop', usage: usage(3000, 800, 49) };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, '@cf/google/gemma-4-26b-a4b-it');
  assert.equal(seen[0].prompt, checkerPrompt(matchData, lines.slice(0, 2)));
  assert.deepEqual(out.verdicts.map((v) => v.result), ['pass', 'unsure']);
  assert.equal(out.usage.neurons, 49);
  assert.throws(() => secondCheckConfig('somewhere'));
});
