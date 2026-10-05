// P1: checks one candidate against its match data with the §3.4 safety-checker prompt (SPEC.md §3.3).
// Fails closed: a refusal or an unparseable verdict is a "fail", never a pass. Throws only when the
// model call itself fails outright. Called by run-pipeline.js; has no CLI of its own.

const { complete, parseJsonReply } = require('./lib/claude-client');
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

function readVerdict(text, stopReason) {
  if (stopReason === 'refusal') return { result: 'fail', reason: 'checker declined to answer (stop_reason refusal)' };
  let verdict;
  try {
    verdict = parseJsonReply(text);
  } catch (err) {
    return { result: 'fail', reason: `unparseable checker reply (stop_reason ${stopReason}): ${err.message}` };
  }
  // Revisions 6 and 7: the checker rules on each rule in turn before its overall verdict. A rule it
  // marked "fail" fails the comment even if the overall result says "pass". A missing list doesn't fail it.
  const rules = readRules(verdict?.rules);
  const failedRule = rules.find((r) => r.result === 'fail');
  const result = String(verdict?.result ?? '').trim().toLowerCase();
  const reason = typeof verdict?.reason === 'string' ? verdict.reason.trim() : '';
  if (result === 'pass' && failedRule) {
    return { result: 'fail', reason: `overall "pass" but rule "${failedRule.rule}" failed: ${failedRule.reason}`, rules };
  }
  if (result === 'pass') return { result: 'pass', reason, rules };
  if (result === 'fail') return { result: 'fail', reason: reason || failedRule?.reason || '(checker gave no reason)', rules };
  return { result: 'fail', reason: `checker returned result ${JSON.stringify(verdict?.result)}, not "pass" or "fail"`, rules };
}

// The checker sees the note too: it's shown to users under the line, so it must be safe to say.
async function safetyCheck(matchData, candidate) {
  const prompt = fillTemplate(TEMPLATE, {
    match_data_json: matchDataJson(matchData),
    comment_json: JSON.stringify({ type: candidate.type, text: candidate.text, note: candidate.note }, null, 2),
  });
  const { text, stopReason, usage } = await complete(prompt);
  return { ...readVerdict(text, stopReason), usage };
}

module.exports = { safetyCheck, readVerdict };
