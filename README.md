# Occam

<p align="center">
  <img src="docs/images/occam-banner.png" alt="A zoomed-out isometric diorama of Occam's flow, staffed by chibi philosophers: Socrates questions the incoming request, Plato and Aristotle weigh two designs, William of Ockham cuts the tangled token stream with a giant razor, Descartes routes the work onto small, medium, and large carts, Karl Popper tests the result, Hypatia files kept knowledge for reuse, and Pythagoras compares a tall stack of coins with a short one." width="100%">
</p>

Use nothing that isn't needed. Occam is a plugin for **Claude Code** and **omp** that aims to spend fewer tokens per task without losing correctness: each step goes to the smallest model that can do it, repetitive tool output is trimmed, project knowledge is reused instead of re-read, and the savings are measured.

> **Status: early.** Working today: installation on both hosts, `/occam-status`, OpenRouter key setup, and the four workflow skills. Model routing, output trimming, the knowledge index, and the token ledger are specified in [the spec](Occam-Token-Optimization-Spec.md) but not built yet.

## Install

```sh
# Claude Code
claude plugin marketplace add febradc-github/occam
claude plugin install occam@occam-plugins

# omp
omp plugin marketplace add febradc-github/occam
omp plugin install occam@occam-plugins
```

Restart your session after installing.

## Commands

| Command | What it does |
|---|---|
| `/occam-status` | Plugin version, host, session, folders, and whether Occam's own model calls are on |
| `/occam-openrouter setup` | Asks for an OpenRouter key, checks it with OpenRouter, and saves it (readable only by you) for both hosts |
| `/occam-openrouter` | Checks the key and model using free OpenRouter calls |
| `/occam-openrouter live` | The same, plus one tiny paid test call |
| `/occam-openrouter remove` | Deletes the saved key |

OpenRouter is used only for Occam's own model calls; Claude Code and omp keep their own providers.

## Skills

| Claude Code | omp | What it does |
|---|---|---|
| `/occam:brainstorm` | `/skill:brainstorm` | Turns an idea into an agreed design, one question at a time |
| `/occam:plan` | `/skill:plan` | Splits the design into small stages, each with a "this is wrong if…" check and exact test commands |
| `/occam:execute` | `/skill:execute` | Runs the stages: check first, then change, then verify, with at most two retries |
| `/occam:review` | `/skill:review` | Has a fresh reviewer try to prove the work wrong before calling it done |

## Development

```sh
npm install
npm run build        # bundles the Claude Code mod and the omp extension
npm test             # unit tests
npm run conformance  # installs into throwaway Claude Code and omp configs and checks both
```

Requires Node 24 or later. Verified with Claude Code 2.1.295 and omp 18.10.1.
