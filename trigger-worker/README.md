# ludicrous-display-trigger

A Cloudflare Worker whose only job is to start the pipeline (`.github/workflows/pipeline.yml`) every hour, at 20 minutes past, UTC. GitHub's own schedule ran it only every 4 to 9 hours, so the schedule now lives here (SPEC.md Revision 22).

**Don't deploy it before go-live.** It starts `pipeline.yml` on `main`, and until `free-to-run` is merged, `main` still writes lines with the paid Claude API.

## What it does

Each cron run makes one request:

```
POST https://api.github.com/repos/henmorgan1-afk/matchday-briefing/actions/workflows/pipeline.yml/dispatches
{"ref":"main"}
```

- **200 or 204:** success. If GitHub returns the new run's URL, it's logged.
- **Anything else:** the status and GitHub's message are logged, and the run fails. The token is never logged.
- **No token:** it logs `GITHUB_DISPATCH_TOKEN missing` and fails.
- **No retries.** The next hour is the retry.
- **The emergency stop:** disable the pipeline workflow in GitHub (Actions tab → pipeline → ⋯ → Disable workflow). The Worker never re-enables it. While it's disabled, each hourly run just logs GitHub's refusal and fails.

It has no public address (`workers_dev` and preview URLs are off, and there's no route), so only its cron can run it. Workers Logs is on, which is included in Workers Free (200,000 events a day, kept 3 days).

## Files

- `wrangler.jsonc`: name, cron, URLs off, logs on, and Wrangler's usage data off.
- `src/index.js`: the scheduled handler.
- `test/index.test.js`: offline tests with `fetch` stubbed. They run in the repo's `npm run test:offline` too.

## Checking it without deploying

```
npm install
npm run test:offline
npm run check        # wrangler deploy --dry-run: bundles and validates, uploads nothing, needs no login
```

## Deploying at go-live

Only after `free-to-run` is merged into `main`.

1. **Make the token.** In GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - Repository access: **Only select repositories** → `matchday-briefing`.
   - Repository permissions: **Actions: Read and write** (GitHub adds Metadata: Read-only itself). Nothing else.
   - Note its expiry date. When it expires, every hourly run logs HTTP 401 until a new one is put in step 4.
2. `npx wrangler login`
3. `npx wrangler deploy` (from this folder).
4. `npx wrangler secret put GITHUB_DISPATCH_TOKEN`, and paste the token when asked. It's held only as this Worker's secret, never in `.env`, GitHub or the repo.
5. After 20 past the next hour, check the Worker's logs in the Cloudflare dashboard for `pipeline dispatched`, and the Actions tab for the run.

It uses 1 of the account's 5 cron triggers on Workers Free; the bin-day app uses another.
