// pipeline.yml's triggers (SPEC.md Revision 22): started only by workflow_dispatch, from the
// Cloudflare Worker in trigger-worker/ or the "Run workflow" button.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'pipeline.yml'), 'utf8');
const code = workflow.replace(/\r\n/g, '\n').replace(/#.*$/gm, '');

test('pipeline.yml has no schedule trigger', () => {
  assert.ok(!/^\s*schedule:/m.test(code));
  assert.ok(!/^\s*-\s*cron:/m.test(code));
});

test('pipeline.yml keeps workflow_dispatch, its optional match input and concurrency', () => {
  assert.match(code, /^on:\n\s+workflow_dispatch:\s*\n\s+inputs:\n\s+match:\n[\s\S]*?required: false/m);
  assert.match(code, /^concurrency:\n\s+group: pipeline\n\s+cancel-in-progress: false/m);
  assert.match(code, /MATCH_ID: \$\{\{ inputs\.match \}\}/);
});
