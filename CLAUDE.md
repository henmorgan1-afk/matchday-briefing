# CLAUDE.md

Build reference: `SPEC.md`. These are working rules for Claude Code sessions in this repo.

## Stopping processes

- When you stop something you started (a local server, a watcher, a test browser), stop only that process, by its process ID or its background task ID.
- Never stop processes by name or type: no `taskkill /IM`, `Stop-Process -Name`, `pkill`, `killall` or anything else that stops every process of one kind. Other programs on this machine may be running the same executable.
- The simplest way: start long-running commands as background tasks, and stop them with their task ID. Otherwise note the PID when you start the process, and use `taskkill /PID <pid>` or `Stop-Process -Id <pid>`.

## Running commands

- Run commands plainly. Don't wrap them in timers, `$(...)` subexpressions or `(Get-Date)` arithmetic, because those always trigger a permission prompt. If timing matters, have the script itself print how long it took.
- Put throwaway scripts (measuring, screenshots, test servers) in scripts/, run them from there, and delete them when done, so they run without approval. Test servers listen on 127.0.0.1 only.

## Previewing lines for free

When asked to "preview lines for match <id>" (or "for the latest matches"), Claude Code writes the lines itself instead of the live model, using `scripts/preview-lines.js`. It reads from Supabase, never writes, and never calls the Anthropic API. Don't run `run-pipeline.js`, `check-p1.js` or anything else that calls the API for this.

1. If there's no match id, or the request is for the latest matches, run `node scripts/preview-lines.js --list` to find it.
2. Run `node scripts/preview-lines.js --match <id>`. It saves the filled generation prompt for each side as `review/preview-<id>-home.md` and `review/preview-<id>-away.md`, and warns if `player_data` isn't `ok`.
3. Read each saved prompt and write the lines yourself, following the prompt exactly, as the live model would: the same count, the same mix of types, and each line with its note.
4. Save them to `review/preview-<id>-lines.json`, shaped `{ "<team short name>": [ { "type", "text", "note" } ] }`, with the home side first.
5. Run `node scripts/preview-lines.js --match <id> --check review/preview-<id>-lines.json`. This runs the automatic checks: the code gate for each side, and the first-three-words variety check across both sides.
6. Judge each line that passed the automatic checks against `prompts/safety-checker-prompt.md`, as the checker would. Go rule by rule (E1 to E9, then the rules for the line's type), using that side's match data from its saved prompt.
7. Show one table per side, with these columns: type, line, note, automatic check result, and safety-check judgement. Give a reason for any fail.
8. End with a reminder that this is a preview written by Claude Code, not the live model, and that no API credits were used.
