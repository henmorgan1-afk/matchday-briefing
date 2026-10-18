Fresh session: read CLAUDE.md, then SPEC.md (Revisions 18–25, especially Revision 23's go-live test and Revision 24's re-test plan) and docs/golive-test-brief.md. Work on the local branch free-to-run (check with git status; switch to it if needed). It has never been pushed.

Task: the re-test (go-live test 2) on matchday 7, over two days. Same four criteria as Revision 23, judged after second attempts.

Rules: free-to-run only; don't push, merge into main or deploy; work through without stopping to ask me anything; skip anything needing a permission I haven't given and list it at the end; never open, print or edit .env or print a secret; don't write to Supabase. Don't change code or prompts during the test: if something breaks, record it and report.

0. Save this prompt word for word as docs/retest-brief.md and commit it, so a later session can continue. Keep progress notes in review/retest-progress.md.
1. Read-only: pick 8 finished matchday 7 matches with player_data ok. Prefer a mix (big win, draw, red card, own goal or penalty if any). List them and why before running anything. If fewer than 8 are ready, use what there is and say so.
2. Day 1: run 4 of them, one at a time: node scripts/run-pipeline.js --match <id> --dry-run. Straight after each, copy review/dryrun-<id>.json to review/retest-<id>.json. Then stop, and tell me in UK time when the last run finished and when day 2 can start (at least 24 hours later). If the allowance runs out (3036), stop and say how many are done. Never rerun a match that completed. If a run fails for another reason, record it, then rerun that match once.
3. Day 2 (when I say continue): run the other 4 the same way.
4. When all 8 are done, fact-check every published line and note against each match's data: every score, count, player, team, half, result, home or away, date, matchday, and which side each player's events helped. List rule breaks and style slips separately. Also compare each side's published lines with that match's live comments in Supabase (read-only).
5. Judge each criterion: zero factual errors in published lines; every side at least 4 published after second attempts; no "MODEL CALL FAILED", unparseable or Groq-stop runs (a Groq reply that recovered on retry is fine, but list it); and the cost per match (neurons with second attempts, Groq tokens, minutes) leaves room for a busy Saturday of about 7 matches in 24 hours. Say pass or fail for each.
6. Add the results to SPEC.md as Revision 26 (go-live test 2), and commit.

Final report, plain English: the 8 matches and why; for each match and side, each attempt's passed/returned/published and a table (type, line, note, published, failed_by, reason); your fact-check; neurons, Groq calls, tokens and run time per match; matches per day; pass or fail on each criterion; every decision you made; anything skipped; confirmation nothing was pushed or deployed.
