// P1: one generation call for one perspective of one finished match (SPEC.md §3.1 step 3, §3.4).
// Returns every candidate the model produced. Malformed items are marked `rejected` here, so they
// fail without spending a safety-check call. Called by run-pipeline.js; has no CLI of its own.

const { COMMENT_TYPES, TARGET_MIX, MAX_COMMENTS_PER_PERSPECTIVE } = require('./lib/constants');
const { complete, parseJsonReply } = require('./lib/claude-client');
const { GENERATION_PROMPT_FILE, loadPrompt, fillTemplate, matchDataJson } = require('./lib/match-data');
const { normaliseDashes } = require('./lib/code-gate');

const TEMPLATE = loadPrompt(GENERATION_PROMPT_FILE);

// The prompt states the mix in prose, so editing TARGET_MIX alone would change PROMPT_VERSION
// without changing what the model is asked for. Refuse to generate until the two agree.
function promptMixProblems(template = TEMPLATE) {
  const problems = [];
  const total = Object.values(TARGET_MIX).reduce((sum, n) => sum + n, 0);
  const stated = template.match(/Write exactly (\d+) comments/);
  if (!stated || Number(stated[1]) !== total) problems.push(`"Write exactly N comments" should say ${total}`);
  const listed = template.match(/a list of (\d+) objects/);
  if (!listed || Number(listed[1]) !== total) problems.push(`"a list of N objects" should say ${total}`);
  for (const [type, n] of Object.entries(TARGET_MIX)) {
    const line = template.match(new RegExp(`^- (\\d+) ${type}:`, 'm'));
    if (!line || Number(line[1]) !== n) problems.push(`"- N ${type}:" should say ${n}`);
  }
  return problems;
}

function normaliseType(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function toCandidate(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { type: null, text: JSON.stringify(item), note: null, rejected: 'not a { type, text, note } object' };
  }
  const type = normaliseType(item.type);
  // Dashes are replaced here (Revision 16), so the checker and the code gate see the final wording.
  const text = typeof item.text === 'string' ? normaliseDashes(item.text.trim()) : '';
  const note = typeof item.note === 'string' ? normaliseDashes(item.note.trim()) : '';
  const candidate = { type: COMMENT_TYPES.includes(type) ? type : item.type ?? null, text, note };
  if (!COMMENT_TYPES.includes(type)) candidate.rejected = `invalid type ${JSON.stringify(item.type)}`;
  else if (!text) candidate.rejected = 'empty text';
  else if (!note) candidate.rejected = 'empty note';
  return candidate;
}

// Returns { candidates, stopReason, usage, parseError, rawText }. A response that can't be parsed
// yields zero candidates (the attempt still counts, SPEC.md §3.1 step 3). Throws only when the
// model call itself fails outright.
async function generateComments(matchData) {
  const problems = promptMixProblems();
  if (problems.length) throw new Error(`prompts/${GENERATION_PROMPT_FILE} disagrees with TARGET_MIX: ${problems.join('; ')}`);

  const prompt = fillTemplate(TEMPLATE, {
    perspective_team_name: matchData.perspective_team,
    match_data_json: matchDataJson(matchData),
  });
  const { text, stopReason, usage } = await complete(prompt);

  let items = [];
  let parseError = null;
  try {
    const parsed = parseJsonReply(text);
    items = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {}).find(Array.isArray);
    if (!items) throw new Error('reply is JSON but contains no list');
  } catch (err) {
    items = [];
    parseError = `unparseable generation reply (stop_reason ${stopReason}): ${err.message}`;
  }

  const candidates = items.map(toCandidate);
  let accepted = 0;
  for (const c of candidates) {
    if (c.rejected) continue;
    if (accepted >= MAX_COMMENTS_PER_PERSPECTIVE) c.rejected = `beyond the first ${MAX_COMMENTS_PER_PERSPECTIVE} candidates`;
    else accepted += 1;
  }

  return { candidates, stopReason, usage, parseError, rawText: parseError ? text : undefined };
}

module.exports = { generateComments, promptMixProblems };
