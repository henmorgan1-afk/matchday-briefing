// Idea 4: the Groq client's pacing and error handling (SPEC.md Revision 21). fetch, sleep and the
// clock are fakes: no request leaves the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockNetwork } = require('./helpers');
const { createGroqClient, durationMs, GROQ_MODEL } = require('../scripts/lib/groq-client');

blockNetwork();

const reply = (content = '{"1": {"result": "pass"}}', headers = {}, outputTokens = 50) => new Response(JSON.stringify({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3000, completion_tokens: outputTokens },
}), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const error = (status, message, headers = {}, code = 'rate_limit_exceeded') => new Response(
  JSON.stringify({ error: { message, type: 'tokens', code } }), { status, headers },
);

// A client whose fetch answers from `responses` in turn, recording each request, with a fake clock
// that `sleep` moves forward.
function client(responses, { apiKey = 'test-key' } = {}) {
  const requests = [];
  const sleeps = [];
  let clock = 1_000_000;
  const groq = createGroqClient({
    apiKey,
    fetch: async (url, init) => {
      requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      const next = responses.shift();
      if (!next) throw new Error('no more fake responses');
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  });
  return { groq, requests, sleeps };
}

test('reads Groq durations', () => {
  assert.equal(durationMs('7.66s'), 7660);
  assert.equal(durationMs('2m59.56s'), 179560);
  assert.equal(durationMs('120ms'), 120);
  assert.equal(durationMs('7'), 7000);
  assert.equal(durationMs('soon'), undefined);
});

test('sends JSON mode, reasoning off (hidden) and max_completion_tokens to the chat endpoint', async () => {
  const { groq, requests } = client([reply()]);
  const out = await groq.complete('Return JSON', { maxCompletionTokens: 900, budgetTokens: 6000 });
  const { url, init, body } = requests[0];
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(
    [body.model, body.response_format, body.reasoning_effort, body.reasoning_format, body.max_completion_tokens],
    [GROQ_MODEL, { type: 'json_object' }, 'none', 'hidden', 900],
  );
  assert.deepEqual([out.text, out.usage.input_tokens, out.usage.output_tokens], ['{"1": {"result": "pass"}}', 3000, 50]);
});

test('waits for the minute reset when the headers say the budget is too low', async () => {
  const low = { 'x-ratelimit-remaining-tokens': '1500', 'x-ratelimit-reset-tokens': '12.5s', 'x-ratelimit-remaining-requests': '990' };
  const { groq, sleeps, requests } = client([reply(undefined, low), reply()]);
  await groq.complete('a', { maxCompletionTokens: 900, budgetTokens: 6000 });
  assert.deepEqual(sleeps, []);
  await groq.complete('b', { maxCompletionTokens: 900, budgetTokens: 6000 });
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 12500 && sleeps[0] <= 13500, `waited ${sleeps[0]} ms`);
  assert.equal(requests.length, 2);
  assert.equal(groq.stats.waits, 1);
});

test("doesn't wait when the budget is enough", async () => {
  const plenty = { 'x-ratelimit-remaining-tokens': '7000', 'x-ratelimit-reset-tokens': '30s' };
  const { groq, sleeps } = client([reply(undefined, plenty), reply()]);
  await groq.complete('a', { maxCompletionTokens: 900, budgetTokens: 6000 });
  await groq.complete('b', { maxCompletionTokens: 900, budgetTokens: 6000 });
  assert.deepEqual(sleeps, []);
});

test('a per-minute 429 waits retry-after, then retries', async () => {
  const { groq, sleeps, requests } = client([
    error(429, 'Rate limit reached for model on tokens per minute (TPM): Limit 8000, Used 7000, Requested 3000.', { 'retry-after': '7' }),
    reply(),
  ]);
  const out = await groq.complete('a', { maxCompletionTokens: 900, budgetTokens: 4000 });
  assert.deepEqual(sleeps, [7000]);
  assert.equal(requests.length, 2);
  assert.equal(out.stopReason, 'stop');
});

test('per-minute 429s that never clear become "unavailable" after a few retries', async () => {
  const tpm = () => error(429, 'Rate limit reached on tokens per minute (TPM)', { 'retry-after': '3' });
  const { groq, requests } = client([tpm(), tpm(), tpm(), tpm()]);
  await assert.rejects(groq.complete('a', { maxCompletionTokens: 900, budgetTokens: 4000 }), { kind: 'unavailable' });
  assert.equal(requests.length, 4);
});

test("the daily limit is its own kind, and isn't retried", async () => {
  const { groq, requests } = client([error(429, 'Rate limit reached for model on tokens per day (TPD): Limit 200000', { 'retry-after': '3600' })]);
  await assert.rejects(groq.complete('a', { maxCompletionTokens: 900, budgetTokens: 4000 }), { kind: 'daily_limit' });
  assert.equal(requests.length, 1);
  // remaining-requests (per day) at 0 stops the next call before it's sent.
  const spent = client([reply(undefined, { 'x-ratelimit-remaining-requests': '0' })]);
  await spent.groq.complete('a', { maxCompletionTokens: 900, budgetTokens: 4000 });
  await assert.rejects(spent.groq.complete('b', { maxCompletionTokens: 900, budgetTokens: 4000 }), { kind: 'daily_limit' });
  assert.equal(spent.requests.length, 1);
});

test('an outage is retried a few times, then "unavailable"', async () => {
  const { groq, requests, sleeps } = client([error(503, 'down', {}, 'service_unavailable'), new TypeError('fetch failed'), error(500, 'x', {}, 'x'), error(502, 'y', {}, 'y')]);
  await assert.rejects(groq.complete('a', { maxCompletionTokens: 900, budgetTokens: 4000 }), { kind: 'unavailable' });
  assert.equal(requests.length, 4);
  assert.deepEqual(sleeps, [2000, 4000, 8000]);
  // And one that recovers.
  const ok = client([error(503, 'down'), reply()]);
  assert.equal((await ok.groq.complete('a', { maxCompletionTokens: 900, budgetTokens: 4000 })).stopReason, 'stop');
});

test('unknown or withdrawn model and rejected key', async () => {
  await assert.rejects(client([error(404, 'The model `qwen/qwen3.8-27b` does not exist', {}, 'model_not_found')]).groq.complete('a', { maxCompletionTokens: 10, budgetTokens: 100 }), { kind: 'model_unavailable' });
  await assert.rejects(client([error(400, 'The model has been decommissioned', {}, 'model_decommissioned')]).groq.complete('a', { maxCompletionTokens: 10, budgetTokens: 100 }), { kind: 'model_unavailable' });
  await assert.rejects(client([error(401, 'Invalid API Key', {}, 'invalid_api_key')]).groq.complete('a', { maxCompletionTokens: 10, budgetTokens: 100 }), { kind: 'key_rejected' });
  // The start-up check: the models endpoint.
  await assert.rejects(client([error(404, 'not found', {}, 'model_not_found')]).groq.preflight(), { kind: 'model_unavailable' });
  await assert.rejects(client([error(401, 'Invalid API Key', {}, 'invalid_api_key')]).groq.preflight(), { kind: 'key_rejected' });
  await assert.rejects(client([new Response(JSON.stringify({ id: GROQ_MODEL, active: false }), { status: 200 })]).groq.preflight(), { kind: 'model_unavailable' });
  const fine = client([new Response(JSON.stringify({ id: GROQ_MODEL, active: true }), { status: 200 })]);
  await fine.groq.preflight();
  assert.equal(fine.requests[0].url, `https://api.groq.com/openai/v1/models/${GROQ_MODEL}`);
  // No key at all.
  await assert.rejects(createGroqClient({ apiKey: '', fetch: async () => reply() }).complete('a', { maxCompletionTokens: 10, budgetTokens: 100 }), { kind: 'key_rejected' });
});

test("a reply Groq's JSON validation rejected comes back empty, so its lines fail closed", async () => {
  const { groq } = client([error(400, 'Failed to generate JSON', {}, 'json_validate_failed')]);
  const out = await groq.complete('a', { maxCompletionTokens: 10, budgetTokens: 100 });
  assert.deepEqual([out.text, out.stopReason], ['', 'json_validate_failed']);
});

test('a request bigger than the minute limit is never sent', async () => {
  const { groq, requests } = client([reply()]);
  await assert.rejects(groq.complete('a', { maxCompletionTokens: 5000, budgetTokens: 9000 }), { kind: 'failed' });
  assert.equal(requests.length, 0);
});

test('paces output: waits until the last minute\'s output plus this call\'s maximum fits 1,000 tokens', async () => {
  const { groq, sleeps, requests } = client([reply(undefined, {}, 700), reply(undefined, {}, 600)]);
  await groq.complete('a', { maxCompletionTokens: 860, budgetTokens: 4500 });
  assert.deepEqual(sleeps, []);
  await groq.complete('b', { maxCompletionTokens: 860, budgetTokens: 4500 });
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 60000 && sleeps[0] <= 61000, `waited ${sleeps[0]} ms`);
  assert.equal(requests.length, 2);
});

test('no request asks for more than 950 output tokens; an output-limit 429 is a minute wait', async () => {
  const big = client([reply()]);
  await assert.rejects(big.groq.complete('a', { maxCompletionTokens: 1200, budgetTokens: 5000 }), { kind: 'failed' });
  assert.equal(big.requests.length, 0);
  // What the first round 4 dry run got, for a request within the cap: wait and retry.
  const otpm = 'Request too large for model `qwen/qwen3.8-27b` on output tokens per minute (OTPM): Limit 1000, Requested 1244.';
  const { groq, sleeps } = client([error(429, otpm), reply()]);
  assert.equal((await groq.complete('a', { maxCompletionTokens: 860, budgetTokens: 4500 })).stopReason, 'stop');
  assert.deepEqual(sleeps, [60000]);
});
