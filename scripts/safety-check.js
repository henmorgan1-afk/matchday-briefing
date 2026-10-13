// P1: checks one perspective's candidates against its match data with the §3.4 safety-checker prompt
// (SPEC.md §3.3), all in one call (Revision 19): the lines go in numbered from 1, and the checker
// returns each line's per-rule verdicts keyed by its number. Fails closed, line by line: a refusal (a
// content-filter stop, Revision 18) or an unparseable reply fails every line, and a line whose verdict
// is missing or unreadable fails. None of them ever passes. Throws only when the model call itself
// fails outright. Called by run-pipeline.js; has no CLI of its own.

const { CHECK_MODEL, complete, parseJsonReply } = require('./lib/ai-client');
const { SAFETY_CHECKER_PROMPT_FILE, loadPrompt, fillTemplate, matchDataJson } = require('./lib/match-data');

const TEMPLATE = loadPrompt(SAFETY_CHECKER_PROMPT_FILE);

// Per-rule verdicts as [{ rule, result, reason }]. Revision 7's compact form is a map of rule id to
// "pass" or "fail: <short reason>"; the Revision 6 form, a list of { rule, result, reason }, is still read.
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
    const verdict = text.match(/^(pass|fail)\b\s*[:\-–—]?\s*(.*)$/is);
    const reason = typeof value === 'object' && value !== null ? String(value.reason ?? '') : verdict?.[2] ?? '';
    return { rule, result: verdict ? verdict[1].toLowerCase() : text.toLowerCase(), reason };
  });
}

// One line's verdict, { rules, result, reason }, as { result, reason, rules }.
function judge(verdict) {
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return { result: 'fail', reason: `checker's verdict for this line isn't readable: ${String(JSON.stringify(verdict)).slice(0, 80)}` };
  }
  // Revisions 6 and 7: the checker rules on each rule in turn before its overall verdict. A rule it
  // marked "fail" fails the comment even if the overall result says "pass". A missing list doesn't fail it.
  const rules = readRules(verdict.rules);
  const failedRule = rules.find((r) => r.result === 'fail');
  const result = String(verdict.result ?? '').trim().toLowerCase();
  const reason = typeof verdict.reason === 'string' ? verdict.reason.trim() : '';
  if (result === 'pass' && failedRule) {
    return { result: 'fail', reason: `overall "pass" but rule "${failedRule.rule}" failed: ${failedRule.reason}`, rules };
  }
  if (result === 'pass') return { result: 'pass', reason, rules };
  if (result === 'fail') return { result: 'fail', reason: reason || failedRule?.reason || '(checker gave no reason)', rules };
  return { result: 'fail', reason: `checker returned result ${JSON.stringify(verdict.result)}, not "pass" or "fail"`, rules };
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

// The checker sees the notes too: they're shown to users under the lines, so they must be safe to say.
// Returns { verdicts, stopReason, usage, problem, rawText }: verdicts line up with `candidates`, and
// problem (with the raw reply, for review) is set when any line had no readable verdict.
async function safetyCheck(matchData, candidates) {
  const comments = Object.fromEntries(candidates.map((c, i) => [String(i + 1), { type: c.type, text: c.text, note: c.note }]));
  const prompt = fillTemplate(TEMPLATE, {
    match_data_json: matchDataJson(matchData),
    comments_json: JSON.stringify(comments, null, 2),
  });
  const { text, stopReason, usage } = await complete(prompt, { model: CHECK_MODEL });
  const verdicts = readVerdicts(text, stopReason, candidates.length);
  const unread = verdicts
    .map((v, i) => (v.rules === undefined && v.result === 'fail' ? i + 1 : null))
    .filter((n) => n !== null);
  const problem = unread.length ? `no readable verdict for line${unread.length > 1 ? 's' : ''} ${unread.join(', ')}: ${verdicts[unread[0] - 1].reason}` : null;
  return { verdicts, stopReason, usage, problem, rawText: problem ? text : undefined };
}

module.exports = { safetyCheck, readVerdicts };
