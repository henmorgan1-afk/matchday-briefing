// P1: checks one perspective's candidates against its match data with the §3.4 safety-checker prompt
// (SPEC.md §3.3), all in one call (Revision 19): the lines go in numbered from 1, and the checker
// returns each line's per-rule verdicts keyed by its number. Fails closed, line by line: a refusal (a
// content-filter stop, Revision 18) or an unparseable reply fails every line, and a line whose verdict
// is missing or unreadable fails. None of them ever passes. Since Revision 21 a rule can also be
// "unsure", which counts as a fail too (idea 5). Throws only when the model call itself fails outright.
//
// The same prompt runs twice (Revision 21 idea 4): safetyCheck is the first checker (CHECK_MODEL, on
// every well-formed line), and secondCheck the second checker (lib/second-checker.js: Groq by default),
// on the lines that passed every earlier step. A line goes live only if both pass it. Called by
// run-pipeline.js; has no CLI of its own.

const { CHECK_MODEL, complete, parseJsonReply } = require('./lib/ai-client');
const { SAFETY_CHECKER_PROMPT_FILE, loadPrompt, fillTemplate, matchDataJson } = require('./lib/match-data');
const { buildFactSheet } = require('./lib/fact-sheet');
const { SECOND_CHECK } = require('./lib/second-checker');
const { GROQ_REASONING, MINUTE_TOKEN_LIMIT, MAX_COMPLETION_TOKENS, GroqError } = require('./lib/groq-client');

const TEMPLATE = loadPrompt(SAFETY_CHECKER_PROMPT_FILE);

const VERDICT = /^(pass|fail|unsure)\b\s*[:\-–—]?\s*(.*)$/is;

// Per-rule verdicts as [{ rule, result, reason }]. Revision 7's compact form is a map of rule id to
// "pass", "fail: <short reason>" or (Revision 21) "unsure: <reason>"; the Revision 6 form, a list of
// { rule, result, reason }, is still read.
function readRules(raw) {
  if (Array.isArray(raw)) {
    return raw.map((r) => ({
      rule: String(r?.rule ?? ''),
      result: String(r?.result ?? '').trim().toLowerCase(),
      reason: String(r?.reason ?? ''),
    }));
  }
  if (raw === null || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([rule, value]) => {
    const text = String(typeof value === 'object' && value !== null ? value.result ?? '' : value ?? '').trim();
    const verdict = text.match(VERDICT);
    const reason = typeof value === 'object' && value !== null ? String(value.reason ?? '') : verdict?.[2] ?? '';
    return { rule, result: verdict ? verdict[1].toLowerCase() : text.toLowerCase(), reason };
  });
}

const ruleNote = (r) => `${r.rule}${r.reason ? `: ${r.reason}` : ''}`;

// One line's verdict, { rules, result, reason }, as { result, reason, rules }. result is "pass",
// "fail" or "unsure"; only "pass" passes.
function judge(verdict) {
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return { result: 'fail', reason: `checker's verdict for this line isn't readable: ${String(JSON.stringify(verdict)).slice(0, 80)}` };
  }
  // Revisions 6 and 7: the checker rules on each rule in turn before its overall verdict. A rule it
  // marked "fail" fails the comment even if the overall result says "pass", and since Revision 21 a
  // rule marked "unsure" makes it unsure. A missing list doesn't fail it.
  const rules = readRules(verdict.rules);
  const failedRule = rules.find((r) => r.result === 'fail');
  const unsureRules = rules.filter((r) => r.result === 'unsure');
  const resultText = String(verdict.result ?? '').trim();
  const result = (resultText.match(VERDICT)?.[1] ?? resultText).toLowerCase();
  const reason = typeof verdict.reason === 'string' ? verdict.reason.trim() : '';
  if (result === 'fail' || ((result === 'pass' || result === 'unsure') && failedRule)) {
    if (result !== 'fail') return { result: 'fail', reason: `overall "${result}" but rule "${failedRule.rule}" failed: ${failedRule.reason}`, rules };
    return { result: 'fail', reason: reason || failedRule?.reason || '(checker gave no reason)', rules };
  }
  if (result === 'unsure' || (result === 'pass' && unsureRules.length)) {
    const which = unsureRules.map(ruleNote).join('; ');
    return { result: 'unsure', reason: which || reason || '(checker gave no reason)', rules };
  }
  if (result === 'pass') return { result: 'pass', reason, rules };
  return { result: 'fail', reason: `checker returned result ${JSON.stringify(verdict.result)}, not "pass", "fail" or "unsure"`, rules };
}

// A line number from a key such as "3", "line 3" or "#3"; null for anything else, rule ids included.
function lineNumber(key) {
  const m = String(key).trim().match(/^(?:line|comment|#)?\s*(\d+)$/i);
  return m ? Number(m[1]) : null;
}

// The reply's verdicts by line number. The prompt asks for an object keyed "1", "2" and so on. One
// object wrapped around that is read too, and so is a list whose entries carry their own "number".
// A list is never read by position, so a skipped verdict can't shift the others onto the wrong lines.
function verdictsByNumber(parsed) {
  const byNumber = new Map();
  const add = (key, value) => {
    const n = lineNumber(key);
    if (n !== null && !byNumber.has(n)) byNumber.set(n, value);
  };
  const read = (value) => {
    if (Array.isArray(value)) for (const v of value) add(v?.number ?? v?.line ?? '', v);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) add(k, v);
  };
  read(parsed);
  if (byNumber.size === 0 && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const inner = Object.values(parsed).filter((v) => v && typeof v === 'object');
    if (inner.length === 1) read(inner[0]);
  }
  return byNumber;
}

// One verdict per line, in order, from the checker's reply to `count` numbered lines.
function readVerdicts(text, stopReason, count) {
  const every = (reason) => Array.from({ length: count }, () => ({ result: 'fail', reason }));
  if (stopReason === 'refusal') return every('checker declined to answer (stop_reason refusal)');
  let parsed;
  try {
    parsed = parseJsonReply(text);
  } catch (err) {
    return every(`unparseable checker reply (stop_reason ${stopReason}): ${err.message}`);
  }
  const byNumber = verdictsByNumber(parsed);
  return Array.from({ length: count }, (_, i) => (byNumber.has(i + 1)
    ? judge(byNumber.get(i + 1))
    : { result: 'fail', reason: `checker gave no verdict for line ${i + 1} (stop_reason ${stopReason})` }));
}

// The filled checker prompt for these candidates, numbered from 1. The checker sees the notes too:
// they're shown to users under the lines, so they must be safe to say.
function checkerPrompt(matchData, candidates) {
  const comments = Object.fromEntries(candidates.map((c, i) => [String(i + 1), { type: c.type, text: c.text, note: c.note }]));
  return fillTemplate(TEMPLATE, {
    fact_sheet: buildFactSheet(matchData),
    match_data_json: matchDataJson(matchData),
    comments_json: JSON.stringify(comments, null, 2),
  });
}

// Lines with no readable verdict, as a problem string for logs and review, or null.
function unreadProblem(verdicts) {
  const unread = verdicts.map((v, i) => (v.rules === undefined && v.result === 'fail' ? i + 1 : null)).filter((n) => n !== null);
  return unread.length ? `no readable verdict for line${unread.length > 1 ? 's' : ''} ${unread.join(', ')}: ${verdicts[unread[0] - 1].reason}` : null;
}

// The first checker. Returns { verdicts, stopReason, usage, problem, rawText }: verdicts line up with
// `candidates`, and problem (with the raw reply, for review) is set when any line had no readable verdict.
async function safetyCheck(matchData, candidates, { completeFn = complete } = {}) {
  const { text, stopReason, usage } = await completeFn(checkerPrompt(matchData, candidates), { model: CHECK_MODEL });
  const verdicts = readVerdicts(text, stopReason, candidates.length);
  const problem = unreadProblem(verdicts);
  return { verdicts, stopReason, usage, problem, rawText: problem ? text : undefined };
}

// ---------------------------------------------------------------- the second checker

// Groq's minute limit counts a request's input plus its max_completion_tokens, and refuses outright a
// request bigger than the limit. Its output limit (1,000 tokens a minute) caps each request's
// max_completion_tokens at MAX_COMPLETION_TOKENS. A verdict took about 150 output tokens a line with
// reasoning off when every rule passed (918 for 6 lines on 15 Oct 2026), and a 4-line request given
// 860 ran out when some verdicts carried reasons. So each line is given 250, which puts at most 3
// lines in a request, and a side's lines are shared evenly between as few requests as that allows.
// Input is estimated from the prompt's length, at first conservatively, then from the characters
// per token Groq reported for earlier calls.
const GROQ_SAFETY_MARGIN = 300;
const GROQ_COMPLETION_PER_LINE = 250;
const GROQ_COMPLETION_BASE = GROQ_REASONING.reasoning_effort === 'none' ? 100 : 1500;
const GROQ_LINES_PER_REQUEST = Math.max(1, Math.floor((MAX_COMPLETION_TOKENS - GROQ_COMPLETION_BASE) / GROQ_COMPLETION_PER_LINE));
let groqCharsPerToken = 3.0;

const estimateTokens = (prompt) => Math.ceil(prompt.length / groqCharsPerToken);

// Each batch of lines that fits one Groq request, with its prompt, estimate and max_completion_tokens.
// A side's lines are shared evenly between ceil(n / GROQ_LINES_PER_REQUEST) batches, and any batch
// still too big for the minute's tokens is split in halves.
function planGroqBatches(matchData, candidates) {
  const batches = Math.ceil(candidates.length / GROQ_LINES_PER_REQUEST);
  const size = Math.ceil(candidates.length / batches);
  const chunks = [];
  for (let i = 0; i < candidates.length; i += size) chunks.push(candidates.slice(i, i + size));
  return chunks.flatMap((chunk) => planChunk(matchData, chunk));
}

function planChunk(matchData, candidates) {
  const plan = (lines) => {
    const prompt = checkerPrompt(matchData, lines);
    const input = estimateTokens(prompt);
    const room = Math.min(MINUTE_TOKEN_LIMIT - GROQ_SAFETY_MARGIN - input, MAX_COMPLETION_TOKENS);
    const wanted = GROQ_COMPLETION_BASE + GROQ_COMPLETION_PER_LINE * lines.length;
    if (wanted <= room) return [{ lines, prompt, input, maxCompletionTokens: wanted }];
    if (lines.length > 1) {
      const half = Math.ceil(lines.length / 2);
      return [...plan(lines.slice(0, half)), ...plan(lines.slice(half))];
    }
    throw new GroqError('failed', `one line's checker request (about ${input} input tokens and ${wanted} output) doesn't fit Groq's limits`);
  };
  return plan(candidates);
}

// The second checker. `deps.groq` is a lib/groq-client.js client (used when the second checker is on
// Groq); `deps.completeFn` is ai-client's complete (used when it's on Cloudflare). Returns
// { verdicts, calls, usage, problem }: verdicts line up with `candidates`, and calls holds each
// request's stop reason, usage, problem and (when a line had no readable verdict) raw reply.
async function secondCheck(matchData, candidates, { groq, completeFn = complete, config = SECOND_CHECK } = {}) {
  const usage = { input_tokens: 0, output_tokens: 0, neurons: 0 };
  const calls = [];
  const verdicts = [];
  const record = (lines, text, stopReason, callUsage, extra = {}) => {
    const vs = readVerdicts(text, stopReason, lines.length);
    const problem = unreadProblem(vs);
    verdicts.push(...vs);
    usage.input_tokens += callUsage.input_tokens;
    usage.output_tokens += callUsage.output_tokens;
    usage.neurons += callUsage.neurons ?? 0;
    calls.push({ lines: lines.length, stop_reason: stopReason, usage: callUsage, ...extra, problem, raw_text: problem ? text : undefined });
  };

  if (config.provider === 'groq') {
    if (!groq) throw new Error('secondCheck needs a Groq client');
    for (const batch of planGroqBatches(matchData, candidates)) {
      const reply = await groq.complete(batch.prompt, {
        model: config.model,
        maxCompletionTokens: batch.maxCompletionTokens,
        budgetTokens: batch.input + batch.maxCompletionTokens,
      });
      if (reply.usage.input_tokens > 0) groqCharsPerToken = Math.min(groqCharsPerToken, (batch.prompt.length / reply.usage.input_tokens) * 0.95);
      record(batch.lines, reply.text, reply.stopReason, reply.usage, { estimated_input_tokens: batch.input, max_completion_tokens: batch.maxCompletionTokens });
    }
  } else {
    const reply = await completeFn(checkerPrompt(matchData, candidates), { model: config.model });
    record(candidates, reply.text, reply.stopReason, reply.usage);
  }
  const problem = calls.map((c) => c.problem).filter(Boolean).join(' | ') || null;
  return { verdicts, calls, usage, problem };
}

module.exports = { safetyCheck, secondCheck, readVerdicts, judge, checkerPrompt, planGroqBatches };
