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

test('the copy check still exempts the reusable idioms', () => {
  assert.deepEqual(copiedFromPrompt('Say what you like, but that was class.'), []);
});
