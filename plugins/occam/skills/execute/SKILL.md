---
name: execute
description: Execute a plan stage by stage, running each stage's falsification check first and its verification commands last, with bounded retries. Use when the user has a plan file and wants it implemented.
---

# Execute a plan

Work through a plan written by the `plan` skill (by default under `docs/plans/`) one stage at a time. A stage is done only when its verification commands have run and passed in this session.

## For each stage, in order

1. **Restate** the stage's goal and acceptance criteria in one or two lines.
2. **Falsify first.** Run the stage's falsification check before changing code. Where the stage starts with a test, write it, run it, and confirm it fails *for the expected reason*. If the check already passes, stop and tell the user: either the work is already done or the check is wrong.
3. **Implement** the smallest change that satisfies the acceptance criteria. Touch only the files the stage names. If more are needed, say why.
4. **Verify.** Run every verification command and report its exit status and the relevant output. Never report a pass you did not observe.
5. **On failure,** form a new hypothesis before retrying; never repeat an identical failed attempt. After **two** failed retries, or when a retry makes no progress (same failing tests, same error), stop and report what you tried and what you learned.
6. **Record** the result: tick the stage's checkbox in the plan and add a one-line evidence note (the command and its result).

## Delegating stages

When a stage suits a subagent, delegate it with a self-contained task that includes the goal, files, acceptance criteria, and verification commands.
- **Claude Code:** the Agent tool takes a `model` per call. Map the stage's tier to `haiku` (`fast`), `sonnet` (`standard`), or `opus` (`deep`).
- **omp:** the task tool has no per-call model; delegate to the `task` agent and note the stage's tier in the task.

Occam's automatic tier routing is not active yet, so these mappings are your choice per stage. Keep the stage in the main session when it is small: a cold subagent rereads context and can cost more than it saves.

## Stop and ask when

- a stage is marked advisor-worthy and the right choice is not obvious;
- the plan turns out to be wrong (a stage cannot pass as written);
- the work needs a permission, credential, or destructive action.

When all stages pass, summarize what changed and the evidence, then offer the `review` skill.
