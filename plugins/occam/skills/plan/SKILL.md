---
name: plan
description: Turn an agreed design into small, ordered stages, each with acceptance criteria, a falsification check, exact verification commands, and a suggested model tier. Use when the user has a design or clear requirements and wants an implementation plan.
---

# Plan verifiable stages

Turn an agreed design into a plan that another session could execute without asking questions. Write no implementation code.

The method is **falsification first**: every stage says how it could be shown wrong, and that check is defined before the work.

## 1. Read the inputs

Read the design note (often `docs/designs/…`) and the code it touches. If there is no agreed design and the change is not trivial, suggest the `brainstorm` skill first.

## 2. Cut the work into stages

Each stage is one reviewable change that ends in a verifiable state. Order the stages so that every one builds on verified ground. Prefer more, smaller stages over fewer, larger ones.

For each stage, write:
- **Goal:** one sentence.
- **Files:** the exact paths to create or change.
- **Task type:** one of `retrieval`, `exploration`, `implementation`, `debugging`, `refactoring`, `review`, `testing`, `architecture`, `documentation`.
- **Risk:** `low`, `medium`, `high`, or `critical`.
- **Tier:** `fast`, `standard`, or `deep`, with a one-line reason:
  - `fast`: mechanical edits, renames, lookups, summaries;
  - `standard`: ordinary implementation, debugging, tests;
  - `deep`: architecture, security-sensitive or high-risk changes, anything that already failed twice.
- **Acceptance criteria:** observable outcomes, not activities.
- **Falsification check:** "This stage is wrong if …", plus the exact command or test that would show it. Where a test can express it, the stage starts by writing that test and watching it fail for the expected reason.
- **Verification:** the exact commands to run at the end, and their expected results.
- **Advisor-worthy:** yes when the stage involves an architectural trade-off, a security-sensitive choice, a broad refactor, or a costly-to-reverse decision.

## 3. Write the plan

Save it next to the design, by default `docs/plans/<YYYY-MM-DD>-<topic>.md`. Start with the goal and a link to the design, then one section per stage with a `- [ ]` checkbox. End with a machine-readable block that Occam's router can read:

```yaml
occamPlan: 1
design: docs/designs/<YYYY-MM-DD>-<topic>.md
stages:
  - id: s1
    goal: "<goal>"
    taskType: implementation
    risk: medium
    tier: standard
    files: [src/example.ts, src/example.test.ts]
    acceptanceCriteria: ["<observable outcome>"]
    falsification: { claim: "<this stage is wrong if …>", command: "<command that would show it>" }
    verification: { commands: ["<exact command>"] }
    advisorWorthy: false
    dependsOn: []
```

## 4. Check the plan before handing it over

- Every acceptance criterion in the design maps to at least one stage.
- Every stage has a falsification check and exact verification commands, with no placeholders.
- No stage depends on a later one.

Then offer the `execute` skill.
