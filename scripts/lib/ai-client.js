// AI client for the pipeline (SPEC.md §1, Revision 18): one OpenAI-compatible chat-completions call,
// made with Node's built-in fetch. AI_PROVIDER picks Cloudflare Workers AI (the default, inside its
// free daily allowance) or a local Ollama server. Model IDs are constants, not env overrides, so a
// stored prompt_version always means the same models (SPEC.md §0, Revision 4); PROMPT_VERSION hashes
// the provider and both model IDs (Revision 18).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const PROVIDERS = Object.freeze({
  // Both are judgment work, so both get the larger model (Revision 19). Checking a side's lines in one
  // call, rather than one call per line, keeps the stronger checker inside the free allowance.
  // claimModel (Revision 21 idea 2) only lists each line's claims, which code then compares with the
  // match data, so it's a cheap model with its reasoning off. secondCheckModel is the second checker's
  // model only when lib/second-checker.js is switched from Groq to this provider.
  cloudflare: Object.freeze({
    generationModel: '@cf/openai/gpt-oss-120b',
    checkModel: '@cf/openai/gpt-oss-120b',
    claimModel: '@cf/zai-org/glm-4.7-flash',
    secondCheckModel: '@cf/google/gemma-4-26b-a4b-it',
  }),
  // For running on the project owner's PC: no key, one model for everything.
  ollama: Object.freeze({
    generationModel: 'gpt-oss:20b',
    checkModel: 'gpt-oss:20b',
    claimModel: 'gpt-oss:20b',
    secondCheckModel: 'gpt-oss:20b',
  }),
});

// Extra request fields per model, from each model's input schema on its Workers AI page (14 Oct 2026):
// JSON object mode for the claim check and the fallback second checker, and GLM's reasoning turned off
// (its chat template's enable_thinking, which defaults to true).
const MODEL_REQUEST_OPTIONS = Object.freeze({
  '@cf/zai-org/glm-4.7-flash': Object.freeze({
    response_format: { type: 'json_object' },
    chat_template_kwargs: { enable_thinking: false },
  }),
  '@cf/google/gemma-4-26b-a4b-it': Object.freeze({ response_format: { type: 'json_object' } }),
});

const PROVIDER = (process.env.AI_PROVIDER ?? '').trim().toLowerCase() || 'cloudflare';
if (!Object.prototype.hasOwnProperty.call(PROVIDERS, PROVIDER)) {
  throw new Error(`AI_PROVIDER must be "cloudflare" or "ollama", not ${JSON.stringify(process.env.AI_PROVIDER)}`);
}
const {
  generationModel: GENERATION_MODEL,
  checkModel: CHECK_MODEL,
  claimModel: CLAIM_MODEL,
  secondCheckModel: SECOND_CHECK_FALLBACK_MODEL,
} = PROVIDERS[PROVIDER];

const OLLAMA_URL = 'http://localhost:11434/v1/chat/completions';

// Workers AI pricing page (13 Oct 2026): neurons per million tokens. The free allowance is 10,000
// neurons a day, reset at 00:00 UTC; on the Workers Free plan, calls beyond it fail, never bill.
// gpt-oss-20b is no longer used on Cloudflare (Revision 19); its rate stays for comparison. The GLM and
// Gemma rates are from Revision 21's brief (14 Oct 2026).
const NEURONS_PER_MILLION_TOKENS = Object.freeze({
  '@cf/openai/gpt-oss-120b': Object.freeze({ input: 31818, output: 68182 }),
  '@cf/openai/gpt-oss-20b': Object.freeze({ input: 18182, output: 27273 }),
  '@cf/zai-org/glm-4.7-flash': Object.freeze({ input: 5500, output: 36400 }),
  '@cf/google/gemma-4-26b-a4b-it': Object.freeze({ input: 9091, output: 27273 }),
});
const FREE_NEURONS_PER_DAY = 10000;

const MAX_TOKENS = 16000;              // includes the model's reasoning; Workers AI defaults to 256
const MAX_RETRIES = 4;                 // 408, 429, 5xx, network errors and timeouts
const RETRY_BASE_MS = 2000;            // backoff of about 2, 4, 8 and 16 s
const RETRY_MAX_MS = 30000;
const RETRY_AFTER_CAP_MS = 60000;      // the most a Retry-After header can make a retry wait
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// A call that failed outright (SPEC.md §3.1 step 3). `status` is the HTTP status, if there was one.
class AiCallError extends Error {
  constructor(message, { status, retryable = false, retryAfterMs, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AiCallError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// Cloudflare's free daily allowance is used up (Workers AI error 3036, HTTP 429). Never retried: the
// run makes no more model calls and leaves the rest for a later run (Revision 18).
class AllowanceUsedUpError extends AiCallError {
  constructor(message, status) {
    super(message, { status });
    this.name = 'AllowanceUsedUpError';
  }
}

const isAllowanceUsedUp = (err) => err instanceof AllowanceUsedUpError;

function endpoint() {
  if (PROVIDER === 'ollama') return { url: OLLAMA_URL, headers: { 'Content-Type': 'application/json' } };
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
  if (!accountId) throw new AiCallError('CLOUDFLARE_ACCOUNT_ID is not set');
  if (!token) throw new AiCallError('CLOUDFLARE_API_TOKEN is not set');
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
}

// Error code 3036 in a Cloudflare error body, or its wording, whichever shape the body takes.
function saysAllowanceUsedUp(body) {
  return /"code"\s*:\s*3036\b/.test(body) || /daily free allocation/i.test(body);
}

// A short, single-line description of an error body: its error codes and messages if it's JSON.
function errorSummary(body) {
  try {
    const json = JSON.parse(body);
    const errors = Array.isArray(json?.errors) ? json.errors : json?.error ? [json.error] : [];
    const text = errors
      .map((e) => (typeof e === 'string' ? e : [e?.code, e?.message].filter(Boolean).join(' ')))
      .filter(Boolean)
      .join('; ');
    if (text) return text.slice(0, 300);
  } catch {
    // not JSON: fall through to the raw text
  }
  return String(body).replace(/\s+/g, ' ').trim().slice(0, 300) || '(empty body)';
}

// Retry-After in seconds or as an HTTP date, capped; undefined if absent or unreadable.
function retryAfterMs(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, RETRY_AFTER_CAP_MS) : undefined;
}

// One request. Returns the parsed reply; throws AiCallError (retryable or not) or AllowanceUsedUpError.
// Error messages never include the URL, which holds the account ID, or the token.
async function postOnce({ url, headers }, model, prompt) {
  let status;
  let ok;
  let retryAfter;
  let body;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: MAX_TOKENS,
        ...(PROVIDER === 'cloudflare' ? MODEL_REQUEST_OPTIONS[model] : undefined),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    ({ status, ok } = response);
    retryAfter = response.headers.get('retry-after');
    body = await response.text();
  } catch (err) {
    const detail = err?.cause?.code || err?.cause?.message || err?.message || String(err);
    throw new AiCallError(`${PROVIDER} request failed (${err?.name ?? 'Error'}: ${detail})`, { retryable: true, cause: err });
  }
  if (!ok) {
    if (PROVIDER === 'cloudflare' && saysAllowanceUsedUp(body)) {
      throw new AllowanceUsedUpError(`free daily allowance used up: ${errorSummary(body)}`, status);
    }
    const retryable = status === 408 || status === 429 || status >= 500;
    throw new AiCallError(`${PROVIDER} returned HTTP ${status}: ${errorSummary(body)}`, { status, retryable, retryAfterMs: retryAfterMs(retryAfter) });
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new AiCallError(`${PROVIDER} reply isn't JSON (${err.message}): ${errorSummary(body)}`, { status });
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function withRetries(fn) {
  for (let retry = 0; ; retry += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!err.retryable || retry >= MAX_RETRIES) throw err;
      const backoff = Math.min(RETRY_BASE_MS * 2 ** retry, RETRY_MAX_MS) * (0.75 + Math.random() / 2);
      await sleep(err.retryAfterMs ?? backoff);
    }
  }
}

// The final answer only. gpt-oss also returns its reasoning, as message.reasoning_content
// (Cloudflare) or message.reasoning (Ollama); neither is read.
function answerText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
  }
  return '';
}

// OpenAI finish reasons, except that a content-filter stop is reported as "refusal", which
// safety-check.js fails closed on.
function stopReasonOf(finishReason) {
  return finishReason === 'content_filter' ? 'refusal' : finishReason ?? null;
}

// Neurons a call used, estimated from its tokens at the pricing page's rates. 0 for a model with no
// rate (Ollama's run locally).
function estimateNeurons(model, inputTokens, outputTokens) {
  const rate = NEURONS_PER_MILLION_TOKENS[model];
  return rate ? (inputTokens * rate.input + outputTokens * rate.output) / 1e6 : 0;
}

// One user-message call. Returns the answer text plus stop reason and token usage (with its neuron
// estimate). Throws only when the call fails outright (network, rate limit or server error after
// retries, bad request, allowance used up): the caller treats that as SPEC.md §3.1 step 3's
// "failed outright".
async function complete(prompt, { model = GENERATION_MODEL } = {}) {
  const target = endpoint();
  const reply = await withRetries(() => postOnce(target, model, prompt));
  const choice = Array.isArray(reply?.choices) ? reply.choices[0] : undefined;
  if (!choice) throw new AiCallError(`${PROVIDER} reply has no choices: ${errorSummary(JSON.stringify(reply))}`);
  const inputTokens = Number(reply.usage?.prompt_tokens) || 0;
  const outputTokens = Number(reply.usage?.completion_tokens) || 0;
  return {
    text: answerText(choice.message),
    stopReason: stopReasonOf(choice.finish_reason),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      neurons: Math.round(estimateNeurons(model, inputTokens, outputTokens) * 10) / 10,
    },
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

// "cloudflare (generation @cf/openai/gpt-oss-120b, safety checks @cf/openai/gpt-oss-120b, claim check
// @cf/zai-org/glm-4.7-flash)". The second checker is described by lib/second-checker.js.
const AI_DESCRIPTION = `${PROVIDER} (generation ${GENERATION_MODEL}, safety checks ${CHECK_MODEL}, claim check ${CLAIM_MODEL})`;

// The run's last line: its estimated neurons against the free daily allowance.
function neuronSummary(neurons) {
  if (PROVIDER !== 'cloudflare') return `Cloudflare neurons this run: none (AI_PROVIDER is ${PROVIDER})`;
  const used = Math.round(neurons);
  const share = Math.round((used / FREE_NEURONS_PER_DAY) * 100);
  return `estimated Cloudflare neurons this run: ${used.toLocaleString('en-GB')} of the ${FREE_NEURONS_PER_DAY.toLocaleString('en-GB')} free per day (${share}%)`;
}

module.exports = {
  PROVIDER,
  GENERATION_MODEL,
  CHECK_MODEL,
  CLAIM_MODEL,
  SECOND_CHECK_FALLBACK_MODEL,
  MODEL_REQUEST_OPTIONS,
  AI_DESCRIPTION,
  NEURONS_PER_MILLION_TOKENS,
  FREE_NEURONS_PER_DAY,
  complete,
  parseJsonReply,
  isAllowanceUsedUp,
  estimateNeurons,
  neuronSummary,
};
