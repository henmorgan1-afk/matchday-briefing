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

// A fake Groq client: answers each request with `reply(prompt, n)` (n counts from 1) and records the
// requests. A reply may be a string, or { text, stopReason }.
function fakeGroq(reply) {
  const requests = [];
  return {
    requests,
    complete: async (prompt, opts) => {
      requests.push({ prompt, opts });
      const r = reply(prompt, requests.length);
      const { text, stopReason } = typeof r === 'string' ? { text: r, stopReason: 'stop' } : r;
      return { text, stopReason, usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 700 } };
    },
  };
}

// The lines a checker prompt holds, by their text.
const linesIn = (prompt) => lines.filter((l) => prompt.includes(JSON.stringify(l.text)));
const allPass = (prompt) => JSON.stringify(Object.fromEntries(linesIn(prompt).map((_, i) => [String(i + 1), { rules: { E1: 'pass' }, result: 'pass' }])));

test('second checker on Groq: unparseable or missing verdicts fail closed, after one retry', async () => {
  const garbledGroq = fakeGroq(() => 'I think they are all fine');
  const garbled = await secondCheck(matchData, lines.slice(0, 3), { groq: garbledGroq });
  assert.deepEqual(garbled.verdicts.map((v) => v.result), ['fail', 'fail', 'fail']);
  assert.equal(garbledGroq.requests.length, 2); // the first try, then one retry, never more
  assert.ok(garbled.verdicts.every((v) => /still no readable verdict after a retry/.test(v.reason)));
  const empty = await secondCheck(matchData, lines.slice(0, 2), { groq: fakeGroq(() => '') });
  assert.ok(empty.verdicts.every((v) => v.result === 'fail'));
  // Line 2's verdict is missing every time.
  const missing = await secondCheck(matchData, lines.slice(0, 2), { groq: fakeGroq((p, n) => (n === 1 ? JSON.stringify({ 1: { rules: { E1: 'pass' }, result: 'pass' } }) : '{}')) });
  assert.deepEqual(missing.verdicts.map((v) => v.result), ['pass', 'fail']);
  assert.deepEqual(missing.retried, [2]);
  assert.match(missing.problem, /no readable verdict for line 2/);
  assert.match(missing.problem, /some still had no readable verdict/);
});

test("Revision 24: Groq's json_validate_failed is retried once, and a good second reply counts", async () => {
  const groq = fakeGroq((prompt, n) => (n === 1 ? { text: '', stopReason: 'json_validate_failed' } : allPass(prompt)));
  const out = await secondCheck(matchData, lines.slice(0, 3), { groq });
  assert.deepEqual(out.verdicts.map((v) => v.result), ['pass', 'pass', 'pass']);
  assert.equal(groq.requests.length, 2);
  assert.deepEqual(out.retried, [1, 2, 3]);
  assert.deepEqual(out.calls.map((c) => Boolean(c.retry)), [false, true]);
  assert.match(out.problem, /every one had a readable verdict the second time/);
});

test('Revision 24: only the lines with no readable verdict are asked about again', async () => {
  // 8 lines go in requests of 3, 3 and 2. The first request misses line 2's verdict, and the third
  // gives line 7 no overall result (every rule passed, so it's unreadable, not a fail).
  const groq = fakeGroq((prompt, n) => {
    const these = linesIn(prompt);
    if (n === 1) return JSON.stringify({ 1: { rules: { E1: 'pass' }, result: 'pass' }, 3: { rules: { E1: 'pass' }, result: 'pass' } });
    if (n === 3) return JSON.stringify({ 1: { rules: { E1: 'pass' } }, 2: { rules: { E1: 'fail: names a manager' } } });
    if (n === 4) {
      assert.deepEqual(these.map((l) => l.text), [lines[1].text, lines[6].text]);
      return JSON.stringify({ 1: { rules: { E1: 'pass' }, result: 'pass' }, 2: { rules: { E7: 'fail: wrong side' }, result: 'fail', reason: 'E7' } });
    }
    return allPass(prompt);
  });
  const out = await secondCheck(matchData, lines, { groq });
  assert.equal(groq.requests.length, 4);
  assert.deepEqual(out.retried, [2, 7]);
  assert.deepEqual(out.verdicts.map((v) => v.result), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail', 'fail']);
  // Line 8 had a failed rule and no overall result: a real fail, not retried.
  assert.match(out.verdicts[7].reason, /rule "E1" failed: names a manager/);
  assert.equal(out.verdicts[6].reason, 'E7');
  assert.ok(out.calls[3].retry && out.calls[3].max_completion_tokens <= MAX_COMPLETION_TOKENS);
});

test("Revision 24: a refusal isn't retried", async () => {
  const groq = fakeGroq(() => ({ text: '', stopReason: 'refusal' }));
  const out = await secondCheck(matchData, lines.slice(0, 2), { groq });
  assert.equal(groq.requests.length, 1);
  assert.deepEqual(out.retried, []);
  assert.ok(out.verdicts.every((v) => v.result === 'fail'));
});

test('Revision 24: the retry is paced like any other Groq request', async () => {
  const { createGroqClient } = require('../scripts/lib/groq-client');
  const sleeps = [];
  const bodies = [];
  let clock = 5_000_000;
  const replies = [
    // 3 lines, 800 output tokens, line 3's verdict missing.
    { content: JSON.stringify({ 1: { rules: { E1: 'pass' }, result: 'pass' }, 2: { rules: { E1: 'pass' }, result: 'pass' } }), out: 800 },
    { content: JSON.stringify({ 1: { rules: { E1: 'pass' }, result: 'pass' } }), out: 200 },
  ];
  const groq = createGroqClient({
    apiKey: 'test-key',
    fetch: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      const r = replies.shift();
      return new Response(JSON.stringify({ choices: [{ message: { content: r.content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3000, completion_tokens: r.out } }), { status: 200 });
    },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  });
  const out = await secondCheck(matchData, lines.slice(0, 3), { groq });
  assert.deepEqual(out.verdicts.map((v) => v.result), ['pass', 'pass', 'pass']);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].max_completion_tokens, 350); // one line: 100 + 250
  // 800 output tokens in the last minute plus up to 350 is over Groq's 1,000, so it waited.
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 60000 && sleeps[0] <= 61000, `waited ${sleeps[0]} ms`);
});

test('second checker on Groq: every request fits the minute limit, splitting a side if needed', async () => {
  const groq = fakeGroq((prompt) => {
    const n = (prompt.match(/"(\d+)": \{\n {4}"type"/g) ?? []).length;
    return JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), { rules: { E1: 'pass' }, result: 'pass' }])));
  });
  const out = await secondCheck(matchData, lines, { groq });
  assert.equal(out.verdicts.length, 8);
  assert.ok(out.verdicts.every((v) => v.result === 'pass'));
  assert.equal(groq.requests.length, 3); // 8 lines go in requests of 3, 3 and 2, for the output limit
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
