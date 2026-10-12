---
name: brainstorm
description: Turn a rough idea into an agreed design before any code is written, by questioning assumptions one at a time and weighing approaches against each other. Use when the user wants to brainstorm, explore, or design a feature, change, or project.
---

# Brainstorm a design

Turn the user's idea into a design they have agreed to. Write no code and change no files except the design note at the end.

Two methods drive this skill:
- **Socratic questioning** to make the goal, constraints, and assumptions explicit.
- **Dialectic** to choose between approaches: argue them against each other, then synthesize.

## 1. Ground yourself

Read what already exists before asking anything: the relevant code, docs, recent commits, and any earlier design notes. Do not ask the user for facts the repository answers.

## 2. Question (Socratic)

Ask **one question per message**. Offer 2 to 4 concrete options when you can, with your recommendation first, and let the user answer in their own words.

Work through, in order, and skip what is already clear:
1. **Goal:** what changes for whom, and why now.
2. **Success:** how we will know it worked. Push until each criterion is observable: a command, a behavior, a number.
3. **Constraints:** hosts, budgets, deadlines, compatibility, security.
4. **Non-goals:** what this deliberately does not do.
5. **Assumptions:** for each one, ask "what must be true for this to work?" and "what would show it is false?". Mark each assumption **confirmed**, **assumed**, or **open**.

Stop questioning when the success criteria are concrete and no open assumption blocks a design choice. If the user says "you decide", choose the conservative option and say so.

## 3. Weigh approaches (dialectic)

Propose 2 or 3 approaches. For the two strongest:
- **Steelman:** the best case for it, in the user's terms.
- **Strongest objection:** the cost, risk, or failure mode that most counts against it.

Then synthesize: pick one, or combine them, and state the reason and what was rejected and why. Prefer the simplest approach that meets the success criteria; cut anything they do not require.

## 4. Present the design

Present the design in short sections sized to its complexity: architecture, components, data flow, error handling, testing. After each section, ask whether it looks right. Revise before moving on.

## 5. Write the design note

Save it to the location the user prefers. The default is `docs/designs/<YYYY-MM-DD>-<topic>.md`, using today's date. Include:
- goal, success criteria, constraints, non-goals;
- assumptions with their status (confirmed / assumed / open);
- the approaches considered, the decision, and the rejected alternatives with reasons;
- the agreed design.

Then offer the `plan` skill to turn the design into verifiable stages.
