Fresh session: first read CLAUDE.md, then SPEC.md (Revisions 18–22) and docs/round4-brief.md. Work on the local branch free-to-run (check with git status; switch to it if needed). It has never been pushed.

Task: the go-live test (idea 8) for the free pipeline. It spans two days, because Cloudflare's free allowance (10,000 neurons a day) resets at 01:00 UK time.

Rules: free-to-run only; don't push or merge into main; don't deploy anything; work through without stopping to ask me anything; skip anything needing a permission I haven't given and list it at the end; never open, print or edit .env or print a secret; don't write to Supabase. Don't change code or prompts during the test: if something breaks, record it and report.

0. Save this prompt word for word as docs/golive-test-brief.md and commit it, so a later session can continue.
1. Read-only: pick 8 finished matches with player_data ok, excluding 560595, 560597 and 560598 (used for tuning). Prefer matchday 6, with a mix: a big win, a draw, and a red card, own goal or penalty if any exist. List them and why before running anything.
2. Run them one at a time: node scripts/run-pipeline.js --match <id> --dry-run. Straight after each, copy review/dryrun-<id>.json to review/golive-<id>.json. If the allowance runs out (3036), stop and say how many are done; I'll ask you to continue after 01:00 UK. Never rerun a match that completed. If a run fails for another reason, record it, then rerun that match once.
3. When all 8 are done, fact-check every published line and note against each match's data: every score, count, player, team, half, result, home or away, date and matchday. List rule breaks and style slips separately.
4. Judge each pass criterion: zero factual errors in published lines; every side at least 4 published; no "MODEL CALL FAILED", unparseable or Groq-stop runs; and the cost per match (neurons, Groq tokens, minutes) leaves room for a busy Saturday of about 7 matches in one UK day. Say pass or fail for each.
5. Add the results to SPEC.md as a new Revision 23 (go-live test), and commit.

Final report, plain English: the 8 matches and why; for each match and side, passed/returned/published and a table (type, line, note, published, failed_by, reason); your fact-check; neurons, Groq calls, tokens and run time per match; matches per day; pass or fail on each criterion; every decision you made; anything skipped; confirmation nothing was pushed or deployed.
