// Offline tests for the hourly trigger (SPEC.md Revision 22). fetch is stubbed in every test,
// so nothing reaches GitHub.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { DISPATCH_URL } from '../src/index.js';

const TOKEN = 'github_pat_TESTONLY_abc123';
const ENV = { GITHUB_DISPATCH_TOKEN: TOKEN };
const realFetch = globalThis.fetch;
let calls;
let logs;

function stubFetch(reply) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return typeof reply === 'function' ? reply() : reply;
  };
}

const run = (env = ENV) => worker.scheduled({ cron: '20 * * * *', scheduledTime: Date.now() }, env, {});

function jsonReply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  logs = [];
  globalThis.fetch = async () => {
    throw new Error('unstubbed fetch');
  };
  mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
});

test('sends one POST to the dispatches URL with the right headers and body', async () => {
  stubFetch(new Response(null, { status: 204 }));
  await run();
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.github.com/repos/henmorgan1-afk/matchday-briefing/actions/workflows/pipeline.yml/dispatches');
  assert.equal(url, DISPATCH_URL);
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'ludicrous-display-trigger',
    'Content-Type': 'application/json',
  });
  assert.equal(init.body, '{"ref":"main"}');
  assert.ok(init.signal instanceof AbortSignal, 'the request has a timeout');
});

test('200 succeeds and logs the run URL GitHub returns', async () => {
  stubFetch(jsonReply(200, {
    workflow_run_id: 123,
    run_url: 'https://api.github.com/repos/henmorgan1-afk/matchday-briefing/actions/runs/123',
    html_url: 'https://github.com/henmorgan1-afk/matchday-briefing/actions/runs/123',
  }));
  await run();
  assert.deepEqual(logs, ['pipeline dispatched: https://github.com/henmorgan1-afk/matchday-briefing/actions/runs/123']);
});

test('200 with only run_url logs that', async () => {
  stubFetch(jsonReply(200, { run_url: 'https://api.github.com/repos/x/y/actions/runs/9' }));
  await run();
  assert.deepEqual(logs, ['pipeline dispatched: https://api.github.com/repos/x/y/actions/runs/9']);
});

test('200 with an unreadable body still succeeds', async () => {
  stubFetch(new Response('not json', { status: 200 }));
  await run();
  assert.deepEqual(logs, ['pipeline dispatched']);
});

test('204 succeeds with no run URL', async () => {
  stubFetch(new Response(null, { status: 204 }));
  await run();
  assert.deepEqual(logs, ['pipeline dispatched']);
});

for (const [status, message] of [
  [401, 'Bad credentials'],
  [404, 'Not Found'],
  [422, 'Cannot trigger a \'workflow_dispatch\' on a disabled workflow'],
]) {
  test(`${status} logs the status and GitHub's message without the token, and throws`, async () => {
    stubFetch(jsonReply(status, { message, documentation_url: 'https://docs.github.com/rest', status: String(status) }));
    await assert.rejects(run(), (err) => {
      assert.equal(err.message, `pipeline dispatch failed: HTTP ${status}`);
      assert.ok(!err.message.includes(TOKEN));
      return true;
    });
    assert.deepEqual(logs, [`pipeline dispatch failed: HTTP ${status}: ${message}`]);
    assert.ok(logs.every((line) => !line.includes(TOKEN)));
    assert.equal(calls.length, 1, 'no retry');
  });
}

test('an error message that echoes the token is redacted', async () => {
  stubFetch(jsonReply(401, { message: `token ${TOKEN} is not valid` }));
  await assert.rejects(run());
  assert.deepEqual(logs, ['pipeline dispatch failed: HTTP 401: token [redacted] is not valid']);
});

test('a non-JSON error body is logged as short text', async () => {
  stubFetch(new Response('x'.repeat(1000), { status: 502 }));
  await assert.rejects(run(), /HTTP 502/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0], `pipeline dispatch failed: HTTP 502: ${'x'.repeat(300)}`);
  assert.equal(calls.length, 1, 'no retry');
});

test('a network error is logged without the token and throws, with no retry', async () => {
  stubFetch(() => {
    throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
  });
  await assert.rejects(run(), { message: 'pipeline dispatch failed: no reply from GitHub' });
  assert.deepEqual(logs, ['pipeline dispatch failed: no reply from GitHub (fetch failed for Bearer [redacted])']);
  assert.equal(calls.length, 1);
});

test('a missing secret logs "GITHUB_DISPATCH_TOKEN missing" and calls nothing', async () => {
  stubFetch(new Response(null, { status: 204 }));
  for (const env of [{}, { GITHUB_DISPATCH_TOKEN: '' }]) {
    logs.length = 0;
    await assert.rejects(run(env), { message: 'GITHUB_DISPATCH_TOKEN missing' });
    assert.deepEqual(logs, ['GITHUB_DISPATCH_TOKEN missing']);
  }
  assert.equal(calls.length, 0);
});

test('the Worker never calls the endpoint that re-enables a workflow', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(!/\/enable\b/.test(source));
  assert.ok(!/\bPUT\b/.test(source));
});

test('wrangler config: name, hourly cron at :20 UTC, no public URLs, logs on, no required secret', () => {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.name, 'ludicrous-display-trigger');
  assert.equal(config.main, 'src/index.js');
  assert.deepEqual(config.triggers, { crons: ['20 * * * *'] });
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.observability?.enabled, true);
  assert.equal(config.secrets, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
});
