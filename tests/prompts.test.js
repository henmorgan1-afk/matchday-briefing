// The existing offline prompt checks, kept as tests: the mix and tail guards, and each prompt file
// matching its SPEC.md §3.4 block byte for byte (line endings normalised, as loadPrompt does).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { blockNetwork } = require('./helpers');
const { promptMixProblems } = require('../scripts/generate-comments');
const { promptTailProblems, copiedFromPrompt } = require('../scripts/lib/code-gate');
const { loadPrompt, PROMPT_VERSION } = require('../scripts/lib/match-data');

blockNetwork();

const ROOT = path.join(__dirname, '..');
const PROMPTS = ['generation-prompt.md', 'safety-checker-prompt.md', 'claim-check-prompt.md'];

test('the generation prompt agrees with TARGET_MIX and the gate\'s banned tails', () => {
  assert.deepEqual(promptMixProblems(), []);
  assert.deepEqual(promptTailProblems(), []);
});

for (const file of PROMPTS) {
  test(`prompts/${file} is byte for byte its SPEC.md §3.4 block`, () => {
    const spec = fs.readFileSync(path.join(ROOT, 'SPEC.md'), 'utf8').replace(/\r\n?/g, '\n');
    const at = spec.indexOf(`**\`prompts/${file}\`**`);
    assert.ok(at >= 0, `SPEC.md §3.4 has no heading for prompts/${file}`);
    const block = spec.slice(at).match(/```\n([\s\S]*?)\n```/);
    assert.ok(block, `no code block after the prompts/${file} heading`);
    const raw = fs.readFileSync(path.join(ROOT, 'prompts', file), 'utf8').replace(/\r\n?/g, '\n');
    assert.ok(raw.endsWith('\n') && !raw.endsWith('\n\n'), `prompts/${file} should end with exactly one newline`);
    assert.equal(raw, `${block[1]}\n`);
    assert.equal(loadPrompt(file), raw);
  });
}

test('the prompts use the new placeholders', () => {
  assert.match(loadPrompt('generation-prompt.md'), /\{\{fact_sheet\}\}\n\nMatch data \(the same facts, as JSON\):\n\{\{match_data_json\}\}/);
  assert.match(loadPrompt('safety-checker-prompt.md'), /\{\{fact_sheet\}\}\n\nMatch data \(the same facts, as JSON\):\n\{\{match_data_json\}\}/);
  assert.doesNotMatch(loadPrompt('generation-prompt.md'), /—/);
  assert.match(PROMPT_VERSION, /^[0-9a-f]{8}$/);
});

test('Revision 24: the checker has a wrong-side rule, E11, and checks every rule up to it', () => {
  const checker = loadPrompt('safety-checker-prompt.md');
  assert.match(checker, /^- E11: talks about a named player, in the comment or its note, as if they\n {2}played for the other team\./m);
  assert.match(checker, /"Lerma showed why we fear him" fails when Lerma plays for us/);
  assert.match(checker, /"our\n {2}Martinez" fails when Martinez plays for them/);
  assert.match(checker, /go through E1 to E11,/);
  assert.match(checker, /"E11": "pass", "<type rule>"/);
  assert.doesNotMatch(checker, /E1 to E10|"E10": "pass", "<type rule>"/);
});

test('Revision 24: the generation prompt ends with a checklist of words the code gate rejects', () => {
  const { side } = require('./helpers');
  const { codeGateProblems } = require('../scripts/lib/code-gate');
  const prompt = loadPrompt('generation-prompt.md');
  const checklist = prompt.slice(prompt.indexOf('Before you answer, check all 8 lines and their notes:'));
  assert.ok(prompt.indexOf('Return JSON: a list of 8 objects') < prompt.indexOf('Before you answer'), 'the checklist comes last');
  const words = [...checklist.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(words, ['finally', 'at last', 'today', 'tonight', 'keeper', 'goalkeeper']);
  assert.match(checklist, /No phrase is used in more than one line\./);
  assert.ok(checklist.endsWith('own words.\n'));
  // Every word on the list fails a STAT or HOT_TAKE line at the code gate.
  const { matchData, names } = side('home');
  for (const w of words) {
    for (const type of ['STAT', 'HOT_TAKE']) {
      assert.ok(codeGateProblems({ type, text: `Won it ${w}. Lovely.`, note: 'From the final score.' }, matchData, names).length, `${type} line with "${w}" passed the gate`);
    }
  }
  // The prompt's own hedge examples no longer offer "If I'm being honest" or "I'll be honest".
  assert.doesNotMatch(prompt, /being honest|I'll be honest|sieve/i);
});

test('the copy check still exempts the reusable idioms', () => {
  assert.deepEqual(copiedFromPrompt('Say what you like, but that was class.'), []);
});
