// Hourly trigger for the pipeline (SPEC.md Revision 22). Each cron run asks GitHub to start
// .github/workflows/pipeline.yml on main, once. It never retries (the next hour is the retry),
// and it never re-enables a disabled workflow: disabling pipeline.yml in GitHub's Actions tab is
// the emergency stop, and while it's disabled every run here logs GitHub's refusal and fails.

export const DISPATCH_URL =
  'https://api.github.com/repos/henmorgan1-afk/matchday-briefing/actions/workflows/pipeline.yml/dispatches';

const TIMEOUT_MS = 30_000;
const MAX_MESSAGE_LENGTH = 300;

export async function dispatchPipeline(env) {
  const token = env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    console.error('GITHUB_DISPATCH_TOKEN missing');
    throw new Error('GITHUB_DISPATCH_TOKEN missing');
  }

  let response;
  try {
    response = await fetch(DISPATCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'ludicrous-display-trigger',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = redact(String(err?.message ?? err), token);
    console.error(`pipeline dispatch failed: no reply from GitHub (${reason})`);
    throw new Error('pipeline dispatch failed: no reply from GitHub');
  }

  if (response.status === 200 || response.status === 204) {
    const runUrl = await readRunUrl(response);
    console.log(runUrl ? `pipeline dispatched: ${runUrl}` : 'pipeline dispatched');
    return { status: response.status, runUrl };
  }

  const message = redact(await readMessage(response), token);
  console.error(`pipeline dispatch failed: HTTP ${response.status}: ${message}`);
  throw new Error(`pipeline dispatch failed: HTTP ${response.status}`);
}

// A 200 carries the new run's details; a 204 has no body.
async function readRunUrl(response) {
  if (response.status !== 200) return null;
  try {
    const body = await response.json();
    return body?.html_url || body?.run_url || null;
  } catch {
    return null;
  }
}

// GitHub's error bodies are JSON with a "message"; anything else is logged as short text.
async function readMessage(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return '(no message)';
  }
  try {
    const message = JSON.parse(text)?.message;
    if (typeof message === 'string' && message) return message.slice(0, MAX_MESSAGE_LENGTH);
  } catch {
    // not JSON
  }
  return text.trim().slice(0, MAX_MESSAGE_LENGTH) || '(no message)';
}

// The token is never logged, even if something echoes it back.
function redact(text, token) {
  return token ? text.split(token).join('[redacted]') : text;
}

export default {
  async scheduled(controller, env, ctx) {
    await dispatchPipeline(env);
  },
};
