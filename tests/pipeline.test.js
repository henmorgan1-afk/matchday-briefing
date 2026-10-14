// The pipeline's new steps and stops (SPEC.md §3.1, Revision 21), run end to end against a fake
// Supabase with every model call stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { blockNetwork, supabaseFor560595, chelseaLines, usage, passVerdict } = require('./helpers');
const { runPipeline } = require('../scripts/run-pipeline');
const { GroqError } = require('../scripts/lib/groq-client');

blockNetwork();

// Stubbed model steps. `second` decides the second checker's verdicts (or throws); `first` the first's.
function deps(supabase, { first, claims, second, preflight, keyMissing = false } = {}) {
  const calls = { generate: 0, first: 0, claims: 0, second: 0, preflight: 0 };
  const logs = [];
  return {
    calls,
    logs,
    deps: {
      supabase,
      fetchMatches: null,
      log: (m) => logs.push(m),
      quietStdout: true,
      reviewDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r21-')),
      secondCheckKeyMissing: keyMissing,
      secondCheckPreflight: async () => { calls.preflight += 1; if (preflight) await preflight(); },
      groqStats: { waitedMs: 0, waits: 0 },
      generateComments: async () => {
        calls.generate += 1;
        return { candidates: chelseaLines(), stopReason: 'stop', usage: usage(2900, 3000, 300) };
      },
      safetyCheck: async (md, lines) => {
        calls.first += 1;
        return { verdicts: lines.map((l, i) => (first ? first(l, i) : { result: 'pass', reason: '', rules: [] })), stopReason: 'stop', usage: usage(3000, 3500, 330) };
      },
      claimCheck: async (md, lines) => {
        calls.claims += 1;
        return { results: lines.map((l, i) => (claims ? claims(l, i) : { result: 'pass', reason: '', checked: l.type === 'STAT' ? 2 : 0, claims: [] })), stopReason: 'stop', usage: usage(1200, 900, 40) };
      },
      secondCheck: async (md, lines) => {
        calls.second += 1;
        if (typeof second === 'function' && second.length === 0) await second();
        return {
          verdicts: lines.map((l, i) => (typeof second === 'function' && second.length ? second(l, i) : { result: 'pass', reason: '', rules: [] })),
          calls: [{ lines: lines.length, usage: usage(3300, 1500) }],
          usage: usage(3300, 1500),
          problem: null,
        };
      },
    },
  };
}

const counters = (sb) => sb.db.matches[0];

test('normal run: 8 written, at most 5 published per side, with a spread of types', async () => {
  const sb = supabaseFor560595();
  const t = deps(sb);
  const { ok } = await runPipeline({ matchId: '999595', dryRun: false }, t.deps);
  assert.equal(ok, true, t.logs.join('\n'));
  const byTeam = (id) => sb.db.comments.filter((c) => c.perspective_team_id === id);
  assert.equal(byTeam('61').length, 5);
  assert.ok(new Set(byTeam('61').map((c) => c.type)).size === 3);
  // The stub writes the same 8 lines for both sides, so the variety check leaves Bournemouth only the
  // 3 lines Chelsea's selection left out. That's under 4, so a second attempt runs, and it adds
  // nothing (duplicates and variety again).
  assert.equal(byTeam('1044').length, 3);
  assert.deepEqual([counters(sb).home_generation_attempts, counters(sb).away_generation_attempts], [1, 2]);
  assert.equal(t.calls.preflight, 1);
  assert.equal(t.calls.generate, 3);
});

test("Groq's daily limit: the attempt is undone, nothing written, no more matches, exit 0", async () => {
  const sb = supabaseFor560595();
  const t = deps(sb, { second: async () => { throw new GroqError('daily_limit', 'tokens per day (TPD)'); } });
  const { ok } = await runPipeline({ matchId: '999595', dryRun: false }, t.deps);
  assert.equal(ok, true);
  assert.deepEqual([counters(sb).home_generation_attempts, counters(sb).away_generation_attempts], [0, 0]);
  assert.equal(sb.db.comments.length, 0);
  assert.equal(t.calls.generate, 1); // the away side wasn't started
  assert.ok(t.logs.includes("Groq's free daily limit is used up, so the remaining matches will be done on a later run."));
  assert.ok(t.logs.some((l) => /bournemouth: 0 stored, deferred to a later run/.test(l)), t.logs.join('\n'));
});

test('Groq down after retries: the attempt is undone, nothing written, exit non-zero', async () => {
  const sb = supabaseFor560595();
  const t = deps(sb, { second: async () => { throw new GroqError('unavailable', 'Groq failed after 3 retries: HTTP 503'); } });
  const { ok } = await runPipeline({ matchId: '999595', dryRun: false }, t.deps);
  assert.equal(ok, false);
  assert.equal(counters(sb).home_generation_attempts, 0);
  assert.equal(sb.db.comments.length, 0);
  assert.equal(t.calls.generate, 1);
  assert.ok(t.logs.some((l) => l.startsWith('GROQ UNAVAILABLE:')));
});

test('unknown or withdrawn model: GROQ MODEL UNAVAILABLE, nothing generated, exit non-zero', async () => {
  const sb = supabaseFor560595();
  const t = deps(sb, { preflight: async () => { throw new GroqError('model_unavailable', "Groq doesn't know qwen/qwen3.8-27b (HTTP 404)"); } });
  const { ok } = await runPipeline({ matchId: '999595', dryRun: false }, t.deps);
  assert.equal(ok, false);
  assert.equal(t.calls.generate, 0);
  assert.ok(t.logs.some((l) => l.startsWith('GROQ MODEL UNAVAILABLE:')), t.logs.join('\n'));
  // Mid-run too, from a chat call.
  const sb2 = supabaseFor560595();
  const t2 = deps(sb2, { second: async () => { throw new GroqError('model_unavailable', 'decommissioned'); } });
  assert.equal((await runPipeline({ matchId: '999595', dryRun: false }, t2.deps)).ok, false);
  assert.equal(counters(sb2).home_generation_attempts, 0);
  assert.ok(t2.logs.some((l) => l.startsWith('GROQ MODEL UNAVAILABLE:')));
});

test('rejected key: GROQ KEY REJECTED, nothing generated, exit non-zero', async () => {
  const sb = supabaseFor560595();
  const t = deps(sb, { preflight: async () => { throw new GroqError('key_rejected', 'Groq rejected the key (HTTP 401)'); } });
  const { ok } = await runPipeline({ matchId: '999595', dryRun: false }, t.deps);
  assert.equal(ok, false);
  assert.equal(t.calls.generate, 0);
  assert.ok(t.logs.some((l) => l.startsWith('GROQ KEY REJECTED:')));
});

test('GROQ_API_KEY missing at start-up: nothing generated, exit non-zero', async () => {
  const sb = supabaseFor560595();
  const t = deps(sb, { keyMissing: true });
  const { ok } = await runPipeline({ matchId: '999595', dryRun: false }, t.deps);
  assert.equal(ok, false);
  assert.equal(t.calls.generate + t.calls.preflight, 0);
  assert.ok(t.logs.includes('GROQ_API_KEY is missing, so nothing is generated this run.'));
  await assert.rejects(runPipeline({ matchId: '999595', dryRun: true }, deps(supabaseFor560595(), { keyMissing: true }).deps), /GROQ_API_KEY is missing/);
});

test('dry run: each step only sees lines that passed the ones before, with every failed_by recorded', async () => {
  const sb = supabaseFor560595();
  const t = deps(sb, {
    // Line 6 (a HOT_TAKE) is unsure for the first checker.
    first: (l) => (l.text.startsWith("Bournemouth's defence") ? { result: 'unsure', reason: 'E7: maybe', rules: [] } : { result: 'pass', reason: '', rules: [] }),
    // The claim check fails "Six goals in the match".
    claims: (l) => (l.text.startsWith('Six goals') ? { result: 'fail', reason: 'claim check: total_goals: says 7', checked: 0, claims: [] } : { result: 'pass', reason: '', checked: l.type === 'STAT' ? 2 : 0, claims: [] }),
    // The second checker fails one line and is unsure of another.
    second: (l) => (l.text.startsWith('Rogers') ? { result: 'fail', reason: 'H3', rules: [] } : l.text.startsWith('That second half') ? { result: 'unsure', reason: 'E5: maybe', rules: [] } : passVerdict()),
  });
  const { ok, output } = await runPipeline({ matchId: '999595', dryRun: true }, t.deps);
  assert.equal(ok, true, t.logs.join('\n'));
  const home = output.perspectives[0];
  const by = (start) => home.candidates.find((c) => c.text.startsWith(start));
  assert.equal(by("Bournemouth's defence").failed_by, 'unsure');
  assert.match(by("Bournemouth's defence").reason, /^unsure \(first checker/);
  assert.equal(by("Bournemouth's defence").steps.claim_check, 'not reached');
  assert.equal(by('Six goals').failed_by, 'claim_check');
  assert.equal(by('Six goals').steps.second_check, 'not reached');
  assert.equal(by('Rogers').failed_by, 'groq');
  assert.match(by('That second half').reason, /^unsure \(second checker \(Groq qwen/);
  assert.deepEqual([home.returned, home.passed, home.published], [8, 4, 4]);
  // The away side reuses the same stub lines, so the variety check drops all of them.
  const away = output.perspectives[1];
  assert.equal(away.published, 0);
  assert.ok(away.candidates.filter((c) => c.steps.variety === 'fail').length === 4);
  assert.deepEqual(output.calls, { generation: 2, safety_check: 2, claim_check: 2, second_check: 2 });
  assert.ok(output.neurons_by_model['@cf/zai-org/glm-4.7-flash']);
  assert.equal(output.groq.calls, 2);
  assert.ok(fs.existsSync(path.join(t.deps.reviewDir, 'dryrun-999595.json')));
});

test('dry run: 7 publishable lines become 5 published, the other 2 not_selected', async () => {
  const sb = supabaseFor560595();
  const t = deps(sb, { first: (l) => (l.text.startsWith('That second half') ? { result: 'fail', reason: 'E5', rules: [] } : { result: 'pass', reason: '', rules: [] }) });
  const { output } = await runPipeline({ matchId: '999595', dryRun: true }, t.deps);
  const home = output.perspectives[0];
  assert.deepEqual([home.passed, home.published], [7, 5]);
  const published = home.candidates.filter((c) => c.published);
  assert.ok(published.some((c) => c.type === 'STAT') && published.some((c) => c.type === 'HOT_TAKE'));
  assert.equal(home.candidates.filter((c) => c.failed_by === 'not_selected').length, 2);
});
