// Which service runs the second checker (SPEC.md Revision 21 idea 4), set here and nowhere else. It
// reads the same checker prompt as the first checker, one call per side, on the lines that passed
// every earlier step, and a line goes live only if both checkers pass it.
//
// 'groq' (the default): Groq's free plan, model GROQ_MODEL in lib/groq-client.js (Qwen, a different
// family from the first checker's gpt-oss). Groq lists that model as Preview, so it may be withdrawn
// at short notice. If it is, set SECOND_CHECK_PROVIDER to 'cloudflare': the second checker then runs on
// the AI_PROVIDER's endpoint with its secondCheckModel (on Cloudflare, @cf/google/gemma-4-26b-a4b-it,
// inside the same free daily allowance as everything else), and GROQ_API_KEY is no longer needed.

const { GROQ_MODEL } = require('./groq-client');
const { PROVIDER, SECOND_CHECK_FALLBACK_MODEL } = require('./ai-client');

const SECOND_CHECK_PROVIDER = 'groq';

// { provider, model, failedBy, name } for a provider setting. failedBy is the dry run's failed_by
// value for a line this checker fails.
function secondCheckConfig(provider = SECOND_CHECK_PROVIDER) {
  if (provider === 'groq') {
    return Object.freeze({ provider: 'groq', model: GROQ_MODEL, failedBy: 'groq', name: `second checker (Groq ${GROQ_MODEL})` });
  }
  if (provider === 'cloudflare') {
    return Object.freeze({
      provider: PROVIDER,
      model: SECOND_CHECK_FALLBACK_MODEL,
      failedBy: 'second_checker',
      name: `second checker (${PROVIDER} ${SECOND_CHECK_FALLBACK_MODEL})`,
    });
  }
  throw new Error(`SECOND_CHECK_PROVIDER must be "groq" or "cloudflare", not ${JSON.stringify(provider)}`);
}

const SECOND_CHECK = secondCheckConfig();

module.exports = { SECOND_CHECK_PROVIDER, SECOND_CHECK, secondCheckConfig };
