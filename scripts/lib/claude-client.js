// Anthropic SDK wrapper for the pipeline (SPEC.md §1). Model IDs are constants, not env
// overrides, so a stored prompt_version always means the same models (SPEC.md §0, Revision 4).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const Anthropic = require('@anthropic-ai/sdk').default;

// Used for both generate-comments.js and safety-check.js: checking is judgment work.
const GENERATION_MODEL = 'claude-sonnet-5';
// Reserved for cleaning/dedupe/format steps inside fetch-matches.js, if any are ever needed.
const MECHANICAL_MODEL = 'claude-haiku-4-5-20251001';

const MAX_TOKENS = 16000; // includes adaptive thinking; non-streaming stays well under SDK timeouts
const MAX_RETRIES = 4;    // SDK retries 408/409/429/5xx and connection errors with backoff

let client;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ maxRetries: MAX_RETRIES });
  }
  return client;
}

// One user-message call. Returns the joined text blocks plus stop reason and token usage.
// Throws only when the call fails outright (network, rate limit after retries, outage, bad request):
// the caller treats that as SPEC.md §3.1 step 3's "failed outright".
async function complete(prompt, { model = GENERATION_MODEL } = {}) {
  const response = await getClient().messages.create({
    model,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return {
    text,
    stopReason: response.stop_reason,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
  };
}

// Parses a reply the prompt asked to be JSON. Tolerates a ```json fence or a sentence around the
// JSON by falling back to the outermost [...] or {...} span. Throws if nothing parses.
function parseJsonReply(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(body);
  } catch (err) {
    const opens = [body.indexOf('['), body.indexOf('{')].filter((i) => i >= 0);
    if (opens.length === 0) throw new Error('no JSON in reply');
    const start = Math.min(...opens);
    const end = body.lastIndexOf(body[start] === '[' ? ']' : '}');
    if (end <= start) throw new Error(`unterminated JSON in reply (${err.message})`);
    return JSON.parse(body.slice(start, end + 1));
  }
}

module.exports = { GENERATION_MODEL, MECHANICAL_MODEL, getClient, complete, parseJsonReply };
