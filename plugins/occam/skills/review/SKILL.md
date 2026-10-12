---
name: review
description: Independently review a change against its plan and acceptance criteria by trying to prove each claim wrong, then give a verdict with file-and-line evidence. Use before calling work done, or when the user asks for a review.
---

# Review by trying to refute

Review a finished change as a skeptic. The goal is to find the reasons it is *not* done, not to confirm that it is. Do not fix anything during the review unless the user asks.

## 1. Get a fresh view

Prefer a reviewer that did not write the change:
- **Claude Code:** delegate to a subagent with the Agent tool, `model: opus`.
- **omp:** delegate to the `reviewer` agent.

Give it the plan, the design, and the diff; not the conversation that produced them.

## 2. Collect the evidence

- The plan and design (by default under `docs/plans/` and `docs/designs/`).
- The full diff, for example `git diff <base>...HEAD` plus uncommitted changes.
- The verification commands from the plan.

## 3. Try to refute each claim

For every acceptance criterion and every stage marked done:
1. **Re-run its verification** and read the output yourself.
2. **Look for a counterexample:** an input, edge case, error path, or concurrent use the tests do not cover. Run it when you can.
3. **Check the falsification check:** does a test exist that would fail if the change were wrong? A test that passes no matter what proves nothing.

Then check across the whole change:
- **Scope:** anything outside the plan, or anything the design listed as a non-goal.
- **Security and privacy:** secrets in code, logs, or command output; unsafe file permissions; untrusted input reaching a shell or a path.
- **Leftovers:** debug code, placeholders, dead code, stale docs.

## 4. Report

List findings by severity: **blocker**, **should fix**, **nit**. Give each one a `path:line` and the evidence (a command and its output, or a quoted line). Then give one verdict:
- **Approve:** every criterion re-verified, no blockers.
- **Changes required:** with the blockers to fix first.

Say what you could not check and why. Never approve on the strength of a claim you did not verify.
