// P1: checks one candidate against its match data with the §3.4 safety-checker prompt (SPEC.md §3.3).
// Fails closed: a refusal or an unparseable verdict is a "fail", never a pass. Throws only when the
// model call itself fails outright. Called by run-pipeline.js; has no CLI of its own.

const { complete, parseJsonReply } = require('./lib/claude-client');
const { SAFETY_CHECKER_PROMPT_FILE, loadPrompt, fillTemplate, matchDataJson } = require('./lib/match-data');

const TEMPLATE = loadPrompt(SAFETY_CHECKER_PROMPT_FILE);

function readVerdict(text, stopReason) {
  if (stopReason === 'refusal') return { result: 'fail', reason: 'checker declined to answer (stop_reason refusal)' };
  let verdict;
  try {
    verdict = parseJsonReply(text);
  } catch (err) {
    return { result: 'fail', reason: `unparseable checker reply (stop_reason ${stopReason}): ${err.message}` };
  }
  const result = String(verdict?.result ?? '').trim().toLowerCase();
  const reason = typeof verdict?.reason === 'string' ? verdict.reason.trim() : '';
  if (result === 'pass') return { result: 'pass', reason };
  if (result === 'fail') return { result: 'fail', reason: reason || '(checker gave no reason)' };
  return { result: 'fail', reason: `checker returned result ${JSON.stringify(verdict?.result)}, not "pass" or "fail"` };
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
