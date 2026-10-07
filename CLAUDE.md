# CLAUDE.md

Build reference: `SPEC.md`. These are working rules for Claude Code sessions in this repo.

## Stopping processes

- When you stop something you started (a local server, a watcher, a test browser), stop only that process, by its process ID or its background task ID.
- Never stop processes by name or type: no `taskkill /IM`, `Stop-Process -Name`, `pkill`, `killall` or anything else that stops every process of one kind. Other programs on this machine may be running the same executable.
- The simplest way: start long-running commands as background tasks, and stop them with their task ID. Otherwise note the PID when you start the process, and use `taskkill /PID <pid>` or `Stop-Process -Id <pid>`.
