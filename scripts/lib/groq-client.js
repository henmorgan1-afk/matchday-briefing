// Groq client for the second checker (SPEC.md §1, Revision 21 idea 4): Groq's OpenAI-compatible chat
// completions API, called with Node's built-in fetch and GROQ_API_KEY, on Groq's free plan (no card).
// The model is set here and nowhere else.
//
// Free-plan limits, for the whole organisation: 30 requests and 8,000 tokens a minute; 1,000 requests
// and 200,000 tokens a day. Groq returns x-ratelimit-* headers on every reply: remaining-tokens and
// reset-tokens are per minute, remaining-requests per day. A 429 carries retry-after (seconds), and a
// single request bigger than the minute limit is refused outright, so each request's input plus its
// max_completion_tokens is kept under it (lib/second-checker.js splits a side's lines if needed).
//
// Errors are GroqError with a `kind` the pipeline acts on:
//   daily_limit        the day's requests or tokens are used up: undo, stop, exit 0
//   unavailable        Groq down, or still rate-limited, after retries: undo, stop, exit non-zero
//   model_unavailable  unknown or withdrawn model: print GROQ MODEL UNAVAILABLE, stop, exit non-zero
//   key_rejected       401/403: print GROQ KEY REJECTED, stop, exit non-zero
//   failed             anything else, such as a request too big for the minute limit: an outright failure
// Error messages never include the key.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
// Alibaba's Qwen: a different family from the first checker's gpt-oss. Groq lists it as Preview, so it
// may be withdrawn at short notice; lib/second-checker.js can switch the second checker to Cloudflare.
const GROQ_MODEL = 'qwen/qwen3.8-27b';
// Reasoning off (Revision 21: "low" if each call fits the minute limit, otherwise "none"). Measured on
// 14 Oct 2026 with round 3's eight Bournemouth lines for 560595: the prompt was 3,550 input tokens, and
// at "low" the model spent 3,225 hidden reasoning tokens and was cut off at 3,500 before its third
// verdict, so a side's call can't fit 8,000 tokens a minute with reasoning on. reasoning_format stays
// "hidden", which Groq requires with JSON mode.
const GROQ_REASONING = Object.freeze({ reasoning_effort: 'none', reasoning_format: 'hidden' });

const MINUTE_TOKEN_LIMIT = 8000;
// Not in the published limits, found in the first round 4 dry run (15 Oct 2026): the free plan also
// caps output at 1,000 tokens a minute ("output tokens per minute (OTPM): Limit 1000"), and refuses
// outright a request whose expected output is over it. So no request asks for more than
// MAX_COMPLETION_TOKENS, and output is paced over a sliding minute.
const MINUTE_OUTPUT_TOKEN_LIMIT = 1000;
const MAX_COMPLETION_TOKENS = 950;
const MINUTE_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_RATE_RETRIES = 3;    // per-minute 429s, each after waiting its retry-after
const MAX_OUTAGE_RETRIES = 3;  // 408, 5xx, network errors and timeouts, after about 2, 4 and 8 s
const RETRY_AFTER_CAP_MS = 65 * 1000;
const RESET_MARGIN_MS = 500;

class GroqError extends Error {
  constructor(kind, message, { status } = {}) {
    super(message);
    this.name = 'GroqError';
    this.kind = kind;
    this.status = status;
  }
}

// "7.66s", "2m59.56s", "1h2m3s" or "120ms" as milliseconds; undefined if unreadable.
function durationMs(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const units = { h: 3600000, m: 60000, s: 1000, ms: 1 };
  let total = 0;
  let matched = '';
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(m[1]) * units[m[2]];
    matched += m[0];
  }
  return matched && matched === text ? total : undefined;
}

// The x-ratelimit-* headers, read at `now`.
function readRateHeaders(headers, now) {
  const num = (name) => {
    const v = headers.get(name);
    return v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
  };
  const reset = durationMs(headers.get('x-ratelimit-reset-tokens'));
  return {
    remainingTokens: num('x-ratelimit-remaining-tokens'),       // per minute
    limitTokens: num('x-ratelimit-limit-tokens'),               // per minute
    tokensResetAt: reset === undefined ? undefined : now + reset,
    remainingRequests: num('x-ratelimit-remaining-requests'),   // per day
  };
}

// A short, single-line description of an error body.
function errorSummary(body) {
  try {
    const json = JSON.parse(body);
    const e = json?.error ?? json;
    const text = [e?.code, e?.type, e?.message].filter(Boolean).join(' ');
    if (text) return text.slice(0, 300);
  } catch {
    // not JSON
  }
  return String(body).replace(/\s+/g, ' ').trim().slice(0, 300) || '(empty body)';
}

const saysPerDay = (body) => /per day|\bTPD\b|\bRPD\b|daily/i.test(body);
const saysModelGone = (body) => /model_not_found|model_decommissioned|decommissioned|does not exist|not found|no longer supported/i.test(body);
const saysJsonFailed = (body) => /json_validate_failed/i.test(body);
const saysTooLarge = (body) => /request too large|too large for model|reduce your message size/i.test(body);
const saysOutputPerMinute = (body) => /output tokens per minute|\bOTPM\b/i.test(body);

// A client with its own pacing state. `fetch`, `sleep` and `now` can be replaced for offline tests.
function createGroqClient({
  apiKey = (process.env.GROQ_API_KEY ?? '').trim(),
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now = () => Date.now(),
  log = () => {},
} = {}) {
  // What the last reply's headers said, so the next call can wait if the minute budget is too low.
  let rate = { remainingTokens: undefined, tokensResetAt: undefined, remainingRequests: undefined };
  // Output tokens of the calls in the last minute, as { at, tokens }, for the output limit.
  let recentOutput = [];
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0, waitedMs: 0, waits: 0 };

  const headers = () => {
    if (!apiKey) throw new GroqError('key_rejected', 'GROQ_API_KEY is not set');
    return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  };

  async function wait(ms, why) {
    if (ms <= 0) return;
    stats.waitedMs += ms;
    stats.waits += 1;
    log(`groq: waiting ${(ms / 1000).toFixed(1)} s (${why})`);
    await sleep(ms);
  }

  async function request(url, init) {
    try {
      const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = await response.text();
      return { response, body };
    } catch (err) {
      const detail = err?.cause?.code || err?.cause?.message || err?.message || String(err);
      return { networkError: `${err?.name ?? 'Error'}: ${detail}` };
    }
  }

  // Start-up check: the key works and the model is listed and active. Throws key_rejected,
  // model_unavailable, or unavailable (Groq down after retries).
  async function preflight(model = GROQ_MODEL) {
    for (let retry = 0; ; retry += 1) {
      const { response, body, networkError } = await request(`${GROQ_MODELS_URL}/${model}`, { method: 'GET', headers: headers() });
      if (response?.ok) {
        let json = null;
        try { json = JSON.parse(body); } catch { /* checked below */ }
        if (json?.id !== model || json?.active === false) throw new GroqError('model_unavailable', `Groq lists ${model} as unavailable: ${errorSummary(body)}`);
        return json;
      }
      const status = response?.status;
      if (status === 401 || status === 403) throw new GroqError('key_rejected', `Groq rejected the key (HTTP ${status}): ${errorSummary(body)}`, { status });
      if (status === 404) throw new GroqError('model_unavailable', `Groq doesn't know ${model} (HTTP 404): ${errorSummary(body)}`, { status });
      const retryable = networkError || status === 408 || status === 429 || status >= 500;
      if (!retryable) throw new GroqError('failed', `Groq model check returned HTTP ${status}: ${errorSummary(body)}`, { status });
      if (retry >= MAX_OUTAGE_RETRIES) throw new GroqError('unavailable', `Groq model check failed after ${MAX_OUTAGE_RETRIES} retries: ${networkError ?? `HTTP ${status} ${errorSummary(body)}`}`, { status });
      await wait(2000 * 2 ** retry, 'Groq model check failed, retrying');
    }
  }

  // One chat completion in JSON object mode. `budgetTokens` is the request's input estimate plus its
  // max_completion_tokens: if the last headers said the minute budget is lower, it waits for the reset.
  // Returns { text, stopReason, usage }; a reply that failed Groq's JSON validation comes back with
  // empty text, so the caller asks about its lines once more and then fails them closed (Revision 24).
  async function complete(prompt, { model = GROQ_MODEL, maxCompletionTokens, budgetTokens } = {}) {
    if (budgetTokens > MINUTE_TOKEN_LIMIT) {
      throw new GroqError('failed', `request needs about ${budgetTokens} tokens, over Groq's ${MINUTE_TOKEN_LIMIT} a minute`);
    }
    if (maxCompletionTokens > MAX_COMPLETION_TOKENS) {
      throw new GroqError('failed', `request asks for ${maxCompletionTokens} output tokens, over the ${MAX_COMPLETION_TOKENS} each request may ask for (Groq's output limit is ${MINUTE_OUTPUT_TOKEN_LIMIT} a minute)`);
    }
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      ...GROQ_REASONING,
      max_completion_tokens: maxCompletionTokens,
    });
    let rateRetries = 0;
    let outageRetries = 0;
    for (;;) {
      if (rate.remainingRequests === 0) throw new GroqError('daily_limit', "Groq's daily request limit is used up (x-ratelimit-remaining-requests is 0)");
      if (rate.remainingTokens !== undefined && budgetTokens !== undefined && rate.remainingTokens < budgetTokens && rate.tokensResetAt > now()) {
        await wait(rate.tokensResetAt - now() + RESET_MARGIN_MS, `${rate.remainingTokens} tokens left this minute, this call needs about ${budgetTokens}`);
        rate = { ...rate, remainingTokens: undefined, tokensResetAt: undefined };
      }
      // The output limit: wait until the last minute's output plus this call's maximum fits.
      recentOutput = recentOutput.filter((o) => o.at > now() - MINUTE_MS);
      let used = recentOutput.reduce((sum, o) => sum + o.tokens, 0);
      if (maxCompletionTokens !== undefined && used + maxCompletionTokens > MINUTE_OUTPUT_TOKEN_LIMIT) {
        const why = `${used} output tokens in the last minute, this call may write ${maxCompletionTokens}`;
        let until = now();
        for (const o of recentOutput) {
          used -= o.tokens;
          until = o.at + MINUTE_MS;
          if (used + maxCompletionTokens <= MINUTE_OUTPUT_TOKEN_LIMIT) break;
        }
        await wait(until - now() + RESET_MARGIN_MS, why);
        recentOutput = recentOutput.filter((o) => o.at > now() - MINUTE_MS);
      }

      const { response, body: replyBody, networkError } = await request(GROQ_CHAT_URL, { method: 'POST', headers: headers(), body });
      if (response) rate = { ...rate, ...readRateHeaders(response.headers, now()) };
      const status = response?.status;

      if (response?.ok) {
        let reply;
        try {
          reply = JSON.parse(replyBody);
        } catch (err) {
          throw new GroqError('failed', `Groq reply isn't JSON (${err.message}): ${errorSummary(replyBody)}`, { status });
        }
        const choice = Array.isArray(reply?.choices) ? reply.choices[0] : undefined;
        if (!choice) throw new GroqError('failed', `Groq reply has no choices: ${errorSummary(replyBody)}`, { status });
        const usage = {
          input_tokens: Number(reply.usage?.prompt_tokens) || 0,
          output_tokens: Number(reply.usage?.completion_tokens) || 0,
          reasoning_tokens: Number(reply.usage?.completion_tokens_details?.reasoning_tokens) || undefined,
        };
        stats.calls += 1;
        stats.inputTokens += usage.input_tokens;
        stats.outputTokens += usage.output_tokens;
        recentOutput.push({ at: now(), tokens: usage.output_tokens });
        const content = choice.message?.content;
        return {
          text: typeof content === 'string' ? content : '',
          stopReason: choice.finish_reason === 'content_filter' ? 'refusal' : choice.finish_reason ?? null,
          usage,
        };
      }

      if (status === 401 || status === 403) throw new GroqError('key_rejected', `Groq rejected the key (HTTP ${status}): ${errorSummary(replyBody)}`, { status });
      if (status === 404 || (status === 400 && saysModelGone(replyBody) && !saysJsonFailed(replyBody))) {
        throw new GroqError('model_unavailable', `Groq can't serve ${model} (HTTP ${status}): ${errorSummary(replyBody)}`, { status });
      }
      if (status === 400 && saysJsonFailed(replyBody)) {
        // The model's reply wasn't valid JSON. It counts against the limits but has no usable verdict.
        stats.calls += 1;
        return { text: '', stopReason: 'json_validate_failed', usage: { input_tokens: 0, output_tokens: 0 } };
      }
      // A request within MAX_COMPLETION_TOKENS that Groq still calls too large for the output limit is
      // waiting on the minute's output budget (Groq estimates a request's output its own way), so it's
      // treated as a per-minute 429 below.
      const outputMinute = status === 429 && saysOutputPerMinute(replyBody);
      if (!outputMinute && (status === 413 || ((status === 400 || status === 429) && saysTooLarge(replyBody)))) {
        throw new GroqError('failed', `Groq refused the request as too large (HTTP ${status}): ${errorSummary(replyBody)}`, { status });
      }
      if (status === 429) {
        if (saysPerDay(replyBody)) throw new GroqError('daily_limit', `Groq's daily limit is used up: ${errorSummary(replyBody)}`, { status });
        if (rateRetries >= MAX_RATE_RETRIES) throw new GroqError('unavailable', `Groq still rate-limited after ${MAX_RATE_RETRIES} retries: ${errorSummary(replyBody)}`, { status });
        rateRetries += 1;
        const after = durationMs(response.headers.get('retry-after'));
        await wait(Math.min(after ?? (outputMinute ? MINUTE_MS : 10000), RETRY_AFTER_CAP_MS), `Groq answered 429 for the minute ${outputMinute ? 'output ' : ''}limit, retry ${rateRetries} of ${MAX_RATE_RETRIES}`);
        rate = { ...rate, remainingTokens: undefined, tokensResetAt: undefined };
        continue;
      }
      if (networkError || status === 408 || status >= 500) {
        if (outageRetries >= MAX_OUTAGE_RETRIES) {
          throw new GroqError('unavailable', `Groq failed after ${MAX_OUTAGE_RETRIES} retries: ${networkError ?? `HTTP ${status} ${errorSummary(replyBody)}`}`, { status });
        }
        outageRetries += 1;
        await wait(2000 * 2 ** (outageRetries - 1), `Groq ${networkError ? 'request failed' : `answered HTTP ${status}`}, retry ${outageRetries} of ${MAX_OUTAGE_RETRIES}`);
        continue;
      }
      throw new GroqError('failed', `Groq returned HTTP ${status}: ${errorSummary(replyBody)}`, { status });
    }
  }

  return { preflight, complete, stats, rateState: () => ({ ...rate }) };
}

module.exports = {
  GROQ_MODEL,
  GROQ_REASONING,
  MINUTE_TOKEN_LIMIT,
  MINUTE_OUTPUT_TOKEN_LIMIT,
  MAX_COMPLETION_TOKENS,
  GroqError,
  createGroqClient,
  durationMs,
  readRateHeaders,
};
