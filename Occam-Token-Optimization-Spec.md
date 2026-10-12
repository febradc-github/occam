# Occam: Token-Optimization Plugin for Claude Code and omp

**Specification version:** 2.0.0  
**Status:** Implementation specification. Host-, provider-, and version-dependent behavior must be re-verified at install time and in CI (§5.9, §15.4).  
**Last reviewed:** 2026-10-12  
**Verified against:** Claude Code 2.1.295; omp (oh-my-pi, built on the Pi harness) 18.10.1  
**Markers:** *[verify]* = documented by the host but not exercised in the §5.9 probe; *[inference]* = derived from documentation, not stated by it. Unmarked host facts are documented, and §5.9 rows were observed directly.

## 1. Purpose

Build an Occam-governed orchestration layer, shipped as **one plugin that installs into both Claude Code and omp**, that reduces avoidable context and token consumption while preserving task correctness, source-code freshness, security, and auditable model selection.

The system combines:

- **Occam policy engine:** deterministic routing decisions from normalized task, risk, capability, budget, and execution-state inputs. Pure and host-agnostic.
- **Host adapters:** a Claude Code adapter (mod plus command hooks) and an omp adapter (extension). Both honor the same behavioral contract; their mechanisms and observability differ and are recorded per host (§5).
- **Dynamic executor routing:** reassesses the next stage throughout a task and selects an eligible executor: a subagent, a headless host session, or (where supported and cost-justified) an in-session model change.
- **Host advisor:** on Claude Code, the server-side advisor tool configured to the `opus` family. On omp, the host-scheduled advisor runtime. Configuring either one does not guarantee a consultation (Claude Code) or a correct review (both).
- **Occam model client:** Occam's own model calls (classification, semantic extraction, summaries) go to OpenRouter under an Occam-only key. The hosts keep their own providers: on this workstation both run on the user's Claude subscription (§6.4).
- **Code knowledge graph:** incremental symbol, dependency, and flow indexing. It uses deterministic extraction where possible and semantic extraction only where it adds value.
- **Obsidian-compatible Markdown vault:** durable, reviewable project knowledge, selected through Occam retention decisions.
- **Context compression:** deduplicate and summarize repetitive tool outputs at insertion time, keeping source references, errors, and required details, without invalidating the prompt cache.
- **Token and quality ledger:** records observed usage per host, distinguishes unknown values from zero, and measures net savings against a comparable baseline.

### Non-goals

- Do not promise identical model output for repeated runs. Determinism applies to Occam's policy decisions when normalized inputs, policy version, and capability registry are identical.
- Do not assume either host supports arbitrary primary-model hot switching during an in-flight request.
- Do not assume a configured advisor is invoked on every task, or that the plugin can observe every advisor event, unless the installed host exposes a reliable signal (§7).
- Do not treat generated notes as more authoritative than the current repository source.
- Do not promise a fixed token reduction. Savings must be measured on representative workloads.
- Do not bypass host permissions, user approvals, provider controls, model allowlists, or safety boundaries.
- Do not fork, patch, or depend on private internals of either host.
- Do not require feature parity between hosts. Parity applies to the behavioral contract; mechanisms and measurement fidelity are allowed to differ and must be reported.
- Do not replace host-native compaction, memory, or routing features. Coordinate with them (§5.6).

## 2. Design principles

1. **Correctness before token reduction.** Do not compress away constraints, errors, test failures, security findings, or information needed to verify a change.
2. **Policy/transport separation.** Occam decides what should run next; adapters decide how to execute it using supported host interfaces.
3. **Explicit state.** Distinguish requested model, actual model when observable, configured advisor, available advisor, and confirmed advisor consultation.
4. **Source of truth.** Current files and tool outputs outrank stored summaries and graph nodes.
5. **Incremental maintenance.** Re-index changed files and affected dependencies rather than rebuilding the entire repository on every request.
6. **Bounded retries and budgets.** Every retry has a reason, objective, and limit; every task has global stage and re-route limits.
7. **Observable degradation.** Any unavailable feature, adapter tier, or fallback is recorded and surfaced.
8. **Least privilege.** Preserve host permissions and scope; never silently grant broader filesystem, shell, network, or credential access.
9. **No false accounting.** Missing usage is `null`/unknown, not zero. Estimates must be labeled estimates.
10. **Reproducible routing.** Version rules, stable ordering, and tie-breakers; log inputs and reasons without storing secrets.
11. **Cache-aware economics.** Cached input is billed far below uncached input. Model switches, retroactive history edits, and unstable injected context destroy cache value. A route or compression that saves raw tokens but invalidates the cache can cost more (§9.5).
12. **Minimal fixed footprint.** Every skill, command, and agent description, every MCP tool schema, and every injected context block is paid on every request. The plugin's always-on footprint has an explicit budget and is measured (§10.6).
13. **Host-neutral core, host-specific edges.** Policy, ledger math, retention, and compression are pure functions shared by both adapters. Only adapters touch host APIs.

## 3. System architecture

### 3.1 Logical flow

```text
User task
   |
   v
Occam Task Normalizer ----> Policy/config/capability registry (per host)
   |                                  |
   v                                  v
Knowledge Retriever <---- Code Graph + Obsidian Vault (occam-knowledge MCP)
   |
   v
Occam Orchestration Controller <---- Token/Quality Ledger
   |
   +----> Executor Router / Host adapter ----> Current host session
   |                                       +-> Subagent with Occam-selected model
   |                                       +-> Headless host session (occam-run)
   |                                       +-> Optional external model adapter
   |
   +----> Host advisor (Claude Code: executor-invoked; omp: host-scheduled)
   |
   v
Stage result -> validation/tests -> next-stage routing decision
   |
   v
Occam retention gate -> vault/graph updates -> final report
```

### 3.2 Deployment units

| Unit | Form | Runs in | Responsibility |
|---|---|---|---|
| `occam-core` | ESM TypeScript library. Policy functions have no I/O, clock, randomness, or environment access. | Imported by every other unit | Normalization, policy, route decisions, ledger math, retention gate, compression transforms |
| Claude Code adapter | Plugin mod (`hooks/register.js`, referenced from `hooks/hooks.json` `modules`) | Claude Code process, in-process | Event capture, compression, routing enforcement, usage capture, in-process knowledge tools and commands |
| omp adapter | Extension declared in `package.json` `omp.extensions` | omp process, in-process (Bun) | Same contract through `pi.on(...)`; knowledge tools through `pi.registerTool` |
| Knowledge service | Library inside each adapter; storage needs only file I/O (§8.2) | In-process with the adapter | Graph/vault query, incremental indexing, retention-gated writes |
| `occam-compat` (optional plugin) | Claude Code command hooks plus a stdio MCP server exposing the knowledge tools | Hook and MCP subprocesses; needs `node` ≥ 22 or `bun` on `PATH`, or shipped compiled executables | Fallback tier for Claude Code environments that block mods but allow command hooks. Not used on omp. |
| `occam-run` | CLI, distributed as a compiled single-file executable per platform | User shell or CI | Orchestrated mode: one headless host session per stage |
| Skills, commands, agents | Markdown, plus code-backed commands registered by the mod and the extension | Both hosts | User entry points (`/occam-*`) and tier subagents |

### 3.3 Operating modes

**Interactive mode.** The host's main model drives the loop, and Occam cannot force it to follow a route. Occam can:

- inject bounded guidance at decision boundaries;
- deterministically choose the model for subagents the main model spawns (Claude Code mod `agent.spawn`; omp `before_subagent_spawn`);
- override the model per request (Claude Code mod `turn.step`; omp `pi.setModel` between requests), but only after the cache-cost check in §9.5;
- block or rewrite tool calls and tool results;
- record usage.

Route compliance (the fraction of Occam-recommended routes actually taken) must be measured and reported.

**Orchestrated mode (`occam-run`).** Occam owns the loop in §4.1. It launches one headless session per stage with an explicit model:

- Claude Code: `claude -p --model <selector> --output-format json|stream-json`
- omp: `omp -p --mode json --model <selector>`, or `omp --mode rpc` with `set_model`

This mode gives authoritative per-stage model selection and usage. Its costs: every stage starts with a cold prompt cache and must receive a compact context package, not a transcript.

Every feature must declare which modes it supports. A feature that only works in one mode is reported as degraded in the other.

### 3.4 Component responsibilities

**Occam policy engine**
- Normalize and quantize task features.
- Apply hard constraints before optimization preferences.
- Select the next stage, model tier, context package, verification requirements, and budget allocation.
- Re-evaluate after stage completion, failed verification, material new evidence, repeated failure, host-initiated model change, compaction, or budget threshold crossing.

**Executor router and host adapters**
- Translate Occam's route decision into a supported host mechanism (§6).
- Confirm the actual model when the host exposes it.
- Report dispatch failure, substitution, unsupported switching, and execution metadata.
- Never claim a model switch succeeded without confirmation.
- Ensure exactly one adapter tier acts on each host event (§5.4).

**Host advisor**
- Claude Code: keep `advisorModel` resolved to `opus` where the provider, version, and model pairing support it. Consultation is decided by the executor model.
- omp: enable the advisor runtime for advisor-worthy stages when policy permits. Consultation is scheduled by the host.
- Do not label a decision as Opus-reviewed without a confirmed consultation signal or an explicit review stage with a recorded result.

**Knowledge service**
- Build and query an incremental graph of files, symbols, imports, calls, tests, and documented flows.
- Store durable Markdown notes in an Obsidian-compatible vault.
- Attach provenance and freshness data to all derived knowledge.
- Expose the smallest possible tool surface to the model (§8.6).

**Context manager**
- Build bounded, task-specific context packages.
- Deduplicate repetitive tool results at insertion time, preserve relevant excerpts and exact errors, and keep references to original files and results.
- Never inject the entire vault or graph into a model call.

**Accounting and evaluation**
- Collect host- and provider-reported usage when available.
- Track estimates separately from actuals.
- Attribute every usage record to exactly one host, model, executor role, and purpose (§10.1).
- Compare quality-adjusted outcomes against a baseline on both hosts.

## 4. Dynamic orchestration policy

### 4.1 Execution loop

1. Normalize the user's request and acceptance criteria.
2. Retrieve the project map and a bounded set of relevant graph/vault entries.
3. Inspect current source as needed; verify freshness before relying on stored notes.
4. Classify task type, uncertainty, complexity, risk, capability requirements, and budget. Heuristics come first (§4.3).
5. Apply hard safety, permission, provider, capability, and budget constraints.
6. Select an eligible tier, mechanism, and execution stage using the versioned Occam policy.
7. Dispatch through a supported adapter and record the requested route.
8. Collect results, observed usage, actual model, file changes, tool errors, and test outcomes.
9. Validate the stage output against its acceptance criteria.
10. Re-route when a defined decision boundary is reached; otherwise continue the current eligible execution path.
11. Stop when acceptance criteria pass, the budget is exhausted, a safety/permission boundary requires user action, or a retry or global limit is exhausted (§4.6).
12. Apply the Occam knowledge-retention gate to candidate reusable knowledge.
13. Produce a final report including completion status, verification, fallbacks, route compliance, and usage confidence.

In interactive mode, steps 6–10 govern subagent dispatch, per-request model overrides, and advisory guidance. The host's main loop stays in control (§3.3).

### 4.2 Decision boundaries

Re-evaluate routing at these boundaries:
- task classification/initial plan;
- completion of an exploration or implementation stage;
- new evidence that changes risk or complexity;
- a failed test or failed acceptance criterion;
- repeated tool/model failure or lack of progress;
- a major design choice or irreversible/high-impact edit;
- a soft-budget threshold;
- a host-initiated model change (Claude Code `PostModelSwitch`; omp `model_change` session entries and `retry_fallback_applied`);
- a compaction (Claude Code `PostCompact` / `SessionStart` with source `compact`; omp `session_compact`);
- before final verification and before committing durable knowledge.

A boundary is a chance for Occam to choose the next action. It does not imply that a new model can be applied to a request that is already in flight.

### 4.3 Deterministic routing

The same normalized feature record, policy version, and capability registry must produce the same route decision on either host.

- The policy is a pure function `route(features, policy, registry) -> RouteDecision`. It must not read clocks, randomness, environment variables, or the filesystem. Time-dependent inputs (elapsed time, remaining budget, cache warmth) are captured into the feature record first.
- Continuous features (complexity, uncertainty, budget fractions) are quantized into configured buckets before evaluation. The policy never compares raw floating-point values.
- Set-valued features (required capabilities) are sorted and deduplicated.
- Classification is heuristic-first: prompt keywords, touched paths, diff size, failing tests, and stage history. An optional LLM classifier runs through Occam's OpenRouter client (§6.4), only when heuristics fall below the configured confidence, with its input hash and output cached. Its usage is attributed to the `routing` purpose, and its output is validated against the schema before it becomes an input.

Decision precedence:
1. Safety, permissions, and user-approval requirements.
2. Required capabilities and provider/model availability on the current host.
3. Hard budget constraints.
4. Task stage and risk tier.
5. Quality target and expected rework risk.
6. Expected cost, including cache re-warm cost (§9.5).
7. Stable configured tie-breaker.

No route may select a model outside both the Occam tier allowlist and the host's own allowlist (Claude Code `availableModels`/`deniedModels`; omp `enabledModels`). Model selectors are resolved at runtime from configuration. Do not scatter hard-coded model IDs across implementation code.

### 4.4 Model tiers

Policy reasons about tiers, never about model names. Adapters resolve tiers per host at dispatch time.

| Tier | Intended stages | Claude Code default selector | omp default selector |
|---|---|---|---|
| `fast` | retrieval, mechanical edits, tool-output summarization, classification | `haiku` | `@smol` (role) |
| `standard` | implementation, debugging, testing | `sonnet` | `@default` (role) |
| `deep` | architecture, high-risk review, stalled tasks | `opus` | `@slow` (role) |

`RouteDecision` records the tier and the requested selector. `ExecutionResult` records the concrete model that actually ran. Aliases and roles can resolve to different concrete models over time and across providers. Claude Code on Bedrock, Vertex, or Foundry resolves its aliases to older versions than on the Anthropic API, and omp roles are user-configured. The ledger therefore always stores the concrete model.

### 4.5 Task record and supporting types

```ts
export type HostId = "claude-code" | "omp";
export type Mode = "interactive" | "orchestrated";
export type Tier = "fast" | "standard" | "deep";
export type Bucket = 0 | 1 | 2 | 3; // configured cut points; the policy reads buckets only

export type TaskType =
  | "retrieval" | "exploration" | "implementation" | "debugging"
  | "refactoring" | "review" | "testing" | "architecture" | "documentation";

export interface TokenBudget {
  hardTokens: number | null;
  softTokens: number | null;
  hardCostUsd: number | null;
  softCostUsd: number | null;
  maxStages: number;
  maxReroutes: number;
  maxElapsedMs: number | null;
  verificationReservePercent: number;
  spent: {
    tokens: number | null;
    costUsd: number | null;
    stages: number;
    reroutes: number;
    elapsedMs: number;
  };
}

export interface NormalizedTask {
  taskId: string;
  host: HostId;
  mode: Mode;
  taskType: TaskType;
  acceptanceCriteria: string[];
  risk: "low" | "medium" | "high" | "critical";
  complexity: Bucket;
  uncertainty: Bucket;
  requiredCapabilities: string[]; // sorted, deduplicated
  remainingBudget: TokenBudget;
  classifierSource: "heuristic" | "llm" | "user";
  policyVersion: string;
  registryVersion: string;
}

export interface VerificationPlan {
  commands: string[]; // exact test/lint/build commands
  acceptanceCriteria: string[];
  requiresIndependentReview: boolean;
  reserveTokens: number | null;
}

export interface VerificationResult {
  status: "passed" | "failed" | "partial" | "not_run";
  commands: Array<{
    command: string;
    exitCode: number | null;
    summary: string;
    outputRef: string | null; // pointer to full output (host spill file, artifact, or Occam store)
  }>;
  unmetCriteria: string[];
}

export interface ContextPackage {
  id: string;
  items: Array<{
    kind: "requirement" | "source_excerpt" | "note" | "graph_node" | "tool_output";
    ref: string; // path:line-range, note id, or output pointer
    contentHash: string;
    freshness: "verified" | "stale" | "unverified";
    fidelity: "exact" | "extracted" | "model_generated";
    text: string;
  }>;
  tokenEstimate: number;
  tokenEstimateMethod: string;
}

export interface RouteDecision {
  taskId: string;
  stageId: string;
  stage: TaskType;
  tier: Tier;
  requestedModel: string; // host selector after tier resolution, e.g. "sonnet" or "@default"
  mechanism: "current_session" | "subagent" | "headless_session" | "in_session_switch" | "external";
  contextPackageId: string;
  verification: VerificationPlan;
  budget: TokenBudget;
  advisorWorthy: boolean;
  reasons: string[]; // rule IDs that fired, in evaluation order
  inputHash: string; // hash of (features, policyVersion, registryVersion)
}
```

Values must be validated at every boundary. Do not trust malformed model-generated classification fields.

### 4.6 Global limits and progress detection

- **Per stage:** default two retries (§11).
- **Per task:** `maxStages`, `maxReroutes`, and at most one tier escalation by default.
- **No-progress detection:** a stage made no progress when the hashes of changed files, the set of failing tests, and the normalized error signatures all match a previous stage. Two consecutive no-progress stages trigger escalation or stop under §11. Loops that alternate between two states are caught the same way, because every prior stage is compared, not just the last one.

### 4.7 Workflow skills and thinking methods

Four skills in `plugins/occam/skills/` give the user a workflow on top of the routing layer. Each is one `SKILL.md` that both hosts load: Claude Code invokes it as `/occam:<skill>` and omp as `/skill:<skill>`. Skill names carry no prefix. Claude Code namespaces them under the plugin. omp does not, so when another plugin ships a skill with the same name, omp keeps the higher-precedence one under the plain name and namespaces the other.

| Skill | Does | Thinking method |
|---|---|---|
| `brainstorm` | Turns an idea into an agreed design note (`docs/designs/<date>-<topic>.md`), one question at a time | Socratic questioning (goal, success criteria, assumptions marked confirmed/assumed/open); dialectic between the two strongest approaches (steelman, strongest objection, synthesis) |
| `plan` | Turns the design into stages (`docs/plans/<date>-<topic>.md`) with task type, risk, tier, acceptance criteria, falsification check, verification commands, and advisor-worthiness | Falsification first: every stage states how it could be shown wrong before work starts |
| `execute` | Runs the stages in order: falsification check first, verification last, at most two retries, evidence recorded per stage | Falsification first |
| `review` | Re-verifies every claim from a fresh reviewer (Claude Code `opus` subagent, omp `reviewer` agent) and gives a verdict with `path:line` evidence | Refutation: look for counterexamples, not confirmation |

- **Plan format:** each plan ends with an `occamPlan: 1` YAML block whose stage fields mirror §4.5 (`taskType`, `risk`, `tier`, `acceptanceCriteria`, `verification.commands`) plus `falsification` and `advisorWorthy`. `occam-run` (phase 4) consumes this block. Until automatic routing exists, `execute` maps tiers by hand: Claude Code's Agent tool takes `model: haiku|sonnet|opus` per call, while omp's task tool has no per-call model.
- **Footprint:** the four descriptions cost about 243 always-on tokens (`claude plugin details`, 2026-10-13). Their bodies (about 470–700 tokens each) are paid only on invocation.
- **Verification:** conformance checks that both hosts load all four skills and that the always-on cost stays within budget. Their behavior with a model has not been exercised yet, because that needs model turns.

## 5. Host integration

### 5.1 Supported hosts and version gates

| Host | Verified | Version gates referenced by this spec |
|---|---|---|
| Claude Code | 2.1.295 | `resolvedModel` on subagent results 2.1.174+; `modelsUsed` 2.1.212+; `PreModelSwitch`/`PostModelSwitch` and resume cost fields 2.1.251+; `/advisor` in `-p`/SDK 2.1.260+; mod `turn.step` `serverToolUses` 2.1.290+; mod tool registration `isDeferred` 2.1.293+; hook `onFailure: "block"` 2.1.295+ |
| omp | 18.10.1 | Earlier versions are unverified. Treat them as capability-unknown and probe. |

Capability detection (§6.1) decides the active feature set at runtime. Version numbers only set expectations; they never replace probes.

### 5.2 Packaging layout

One repository and one marketplace serve both hosts. The main plugin `occam` needs no external runtime. The optional `occam-compat` plugin holds everything that runs as a subprocess.

```text
occam-marketplace/
  .claude-plugin/marketplace.json     # Claude Code reads it; omp uses it as its fallback catalog
  plugins/occam/                        # install on both hosts
    .claude-plugin/plugin.json        # Claude manifest; omp reads skills/commands/version from it
    package.json                      # "omp": { "extensions": ["./dist/omp-extension.js"] }; Claude Code ignores it
    skills/<name>/SKILL.md            # both hosts
    commands/*.md                     # both hosts, for prompt-only commands; code-backed /occam-* commands are registered by the mod and the extension
    agents/occam-fast.md                # both hosts; omp discards `model` (routing via the extension instead)
    agents/occam-standard.md
    agents/occam-deep.md
    hooks/hooks.json                  # Claude Code only: { "modules": ["./register.js"] }, no command hooks
    hooks/register.js                 # Claude Code mod entry point (bundled ESM)
    dist/omp-extension.js             # omp extension entry point (bundled ESM)
  plugins/occam-compat/                 # optional, Claude Code only
    .claude-plugin/plugin.json
    hooks/hooks.json                  # exec-form command hooks
    .mcp.json                         # knowledge MCP server; paths use ${CLAUDE_PLUGIN_ROOT}
    dist/                             # hook and MCP entry points (scripts or compiled executables)
```

Packaging rules:
- Never put files under `hooks/pre/`, `hooks/post/`, or `tools/` unless omp should execute them. omp loads `.ts`/`.js` files there as extensions or custom tools. The Claude Code mod therefore lives at `hooks/register.js`.
- Do not ship `.omp-plugin/marketplace.json` unless it is generated from the Claude catalog. omp prefers it when present, so a hand-maintained copy can drift.
- Do not ship a plugin-root `CLAUDE.md`. Claude Code does not load it, and the validator warns about it.
- Do not write state under the plugin root. Claude Code's `${CLAUDE_PLUGIN_ROOT}` changes on every update, and omp's plugin cache directory is shared by user and project scopes.
- Claude Code plugin `settings.json` can only set `agent` and `subagentStatusLine`; every other key is dropped. A plugin therefore cannot set `advisorModel`, `model`, or `env` declaratively (§7.2).
- Claude Code plugin agents ignore `hooks`, `mcpServers`, and `permissionMode` frontmatter. Do not rely on them.
- Use relative, `github`, `url`, or `git-subdir` marketplace sources. omp parses `npm` sources but does not install them.
- Plugin names: `occam`, `occam-compat`. omp requires ASCII letters, digits, `-`, and `.`, at most 64 characters; Claude Code accepted names of this form in §5.9.
- Bundle each in-process entry point (`hooks/register.js`, `dist/omp-extension.js`) as one self-contained ESM file. Neither host installs plugin dependencies for a Claude-format plugin *[inference for Claude Code; omp links marketplace plugins into `node_modules` but documents no dependency install]*.
- Claude Code statically checks mod code at validation and at load. The mods API object `$` may appear only as call sites of the form `$.namespace.method(...)`; passing, binding, spreading, returning, or reading `$` as a value fails the load. The mod adapter therefore hands `occam-core` capability ports, i.e. closures such as `{ write: (p, t) => $.fs.write(p, t) }`, never `$` itself. The bundler must not rename or minify `$` in `hooks/register.js`, and CI runs `claude plugin validate`, which lists the mod's hooks and calls (§5.9).
- Mod `$.fs.read`/`$.fs.write` handle at most 4 MiB per file, so every index file Occam writes, the manifest included, is sharded below that size (§8.2).

Install:
- Claude Code: `claude plugin marketplace add <repo>`, then `claude plugin install occam@<marketplace> [-s user|project|local]`. Add `occam-compat@<marketplace>` only where mods are blocked and a runtime is available. For development: `claude --plugin-dir ./plugins/occam`.
- omp: `omp plugin marketplace add <repo>`, then `omp plugin install [--scope user|project] occam@<marketplace>`. For development: `omp -e ./plugins/occam/dist/omp-extension.js`. `omp --plugin-dir ./plugins/occam` loads the Claude-format components but **not** `package.json` `omp.extensions` (observed on 18.10.1, §5.9). `/reload-plugins` refreshes skills, commands, agents, and MCP servers; new extension code needs a session restart.

### 5.3 Component mapping

| Occam component | Claude Code | omp | Notes |
|---|---|---|---|
| Entry commands (`occam-status`, `occam-openrouter`, planned `occam-setup`, `occam-report`, `occam-index`) | Mod `$.command.register` plus `command.run`, invoked as `/occam-<name>` | Extension `pi.registerCommand`, invoked as `/occam-<name>` | Code-backed on both hosts and answered without a model turn. Mod command names allow only letters, digits, `_`, and `-`, so the plugin uses `occam-` rather than the `occam:` prefix Markdown commands get. |
| Tier subagents | `agents/occam-*.md` with `model:` frontmatter | Same files load; `model` is discarded for Claude-format packages. The extension's `before_subagent_spawn` handler supplies the tier model. | Agent names are the routing key on both hosts |
| Knowledge tools | Mod registers `occam_context`, `occam_lookup`, `occam_remember` in `session.start` via `$.tool.register` and answers them in `tool.call`; Claude sees `mcp__occam__<tool>`. Under `occam-compat`: the same tools from the MCP server (`mcp__plugin_occam-compat_<server>__<tool>`). | Extension `pi.registerTool` (in-process) | One tool implementation in `occam-core`; only the registration differs. `${CLAUDE_PLUGIN_ROOT}` (MCP config) is substituted by both hosts; `${CLAUDE_PLUGIN_DATA}` is Claude Code only. |
| Event adapter | Mod `register(on, options)`; command hooks only in `occam-compat` | Extension `pi.on(...)` | §5.4 |
| User options | `userConfig` in `plugin.json` (non-sensitive values go to `pluginConfigs` in user settings; sensitive ones to the keychain) | `package.json` `omp.settings`; `omp plugin config --set key=value` | The Occam config file (§13) is the source of truth. Host options only locate it or toggle features. |

### 5.4 Lifecycle event mapping

Exactly one adapter tier acts on each event. On Claude Code the mod tier (`occam`) is primary. If `occam-compat` is also installed, its command hooks must no-op for any session in which the mod tier is active; they coordinate through a per-session state file keyed by session ID.

| Occam need | Claude Code mod (`occam`) | Claude Code command hooks (`occam-compat`) | omp extension (`occam`) |
|---|---|---|---|
| Session start: config, capability probe, tool/command registration, minimal project pointer | `session.start` (event fields observed: `cwd`, `surface`, `isInteractive`); registers tools and commands with `$.tool.register`/`$.command.register`; Claude Code waits for it before the first prompt | `SessionStart` (`additionalContext`; `watchPaths` to arm `FileChanged`) | `session_start`; `before_agent_start` for system-prompt additions |
| Prompt intake / classification | `turn.start` *[verify payload fields]* | `UserPromptSubmit` (adds context; cannot rewrite the prompt) | `input` (interactive/RPC) or `before_agent_start` |
| Pre-tool guard or rewrite | `tool.call` → `next(e)`, `{ deny }`, or `{ result }` | `PreToolUse` → `permissionDecision`, `updatedInput`, `additionalContext` | `tool_call` → `{ block, reason, input, additionalContext }` (fails closed on error or timeout) |
| Tool-result compression | `session.append` (rewrites the stored `tool_result` content) | `PostToolUse` → `updatedToolOutput` (must match the tool's output shape; for Bash: `stdout`, `stderr`, `interrupted`, `isImage`) | `tool_result` → `{ content, details, isError }` (middleware chain) |
| Per-request model override | `turn.step` → `next({ ...e, model })` | none | `pi.setModel` between requests |
| Per-request usage and actual model | `turn.step` result `usage` and `model` | none (transcript parsing, §10.3) | `message_end` (`message.usage`, `message.model`, `message.provider`) |
| Subagent model selection | `agent.spawn` → `next({ ...e, model })` or `{ deny }` | none (frontmatter or per-call `model` only) | `before_subagent_spawn` → `{ model, block, reason, note }` |
| Subagent completion | *[verify]* | `SubagentStop` (`agent_transcript_path`); `PostToolUse` matched on `Agent` (`tool_response` is the subagent result) | task `SingleResult` (`resolvedModel`, `usage`); child `agent_end` (`ctx.agent.kind === "sub"`) |
| Model switch observed or gated | *[verify]* | `PreModelSwitch` (deny/ask; carries `prompt_cache_warm`, `estimated_cache_write_usd`); `PostModelSwitch` | `model_change` entries; `retry_fallback_applied`. No dedicated extension event. |
| File changed outside tool calls | *[verify]* | `FileChanged` (filesystem watcher; catches Bash and external writes) | none. Mark affected paths dirty after `bash` tool results and re-hash lazily. |
| Compaction | `session.compact` → `{ skip }` | `PreCompact` (block only); `PostCompact` (`compact_summary`); `SessionStart` with source `compact` | `session_before_compact` (`{ cancel, compaction }`, can supply the summary); `session.compacting`; `session_compact` |
| Stop / final report | `turn.complete` (`{ text }` line under the answer) | `Stop` (`decision: "block"` continues; at most 8 consecutive continuations); `systemMessage` shown to the user | `session_stop` (`{ continue, additionalContext }`, at most 8; or `{ decision: "block", reason }`) |
| Session-end flush | *[verify]* | `SessionEnd` (1.5 s shared budget by default) | `session_shutdown` (2 s budget) |
| Cache-warm economics | none | `PreModelSwitch` fields | `cache_warming_decision` (`warmCost`, `missCost`, `continuationProbability`) |

Claude Code mods stop loading under `disableAllHooks`, `--bare`, `--safe-mode`, or an organization's `allowManagedModsOnly`, and their loading is held for a server-side rollout flag (§5.9). `disableAllHooks` and `--bare` also stop command hooks. Without the mod tier, and without a working `occam-compat`, the plugin falls back to **advisory-only mode**: skills, commands, and agents, with no compression, no enforcement, and no knowledge tools. That mode is reported (§11). `--safe-mode` disables installed plugins entirely, so nothing from Occam loads.

### 5.5 Executor capability matrix

| Capability | Claude Code | omp |
|---|---|---|
| Launch session | `claude -p`, `--bg`, Agent SDK | `omp -p --mode json`, `omp --mode rpc`, SDK |
| Resume session | `--resume`, `--continue`, `--fork-session`, `--session-id` | `--resume`, `--continue`, RPC `open_session`/`switch_session` |
| Dispatch subagent | Agent tool | task tool |
| Select subagent model | frontmatter `model`; per-call `model`; `CLAUDE_CODE_SUBAGENT_MODEL`; mod `agent.spawn` | `task.agentModelOverrides`; `@role` frontmatter (non-Claude-format agents only); `before_subagent_spawn`. The task tool has no per-call model field. |
| Switch primary model in session | From the next request onward: `/model`; skill `model` (rest of the turn); mod `turn.step` (per request) | Between requests: `/model`, RPC `set_model`, `pi.setModel`. Automatic: retry fallback chains, context promotion, prewalk. |
| Report actual model | transcript `message.model`; subagent `resolvedModel`/`modelsUsed`; `-p` `modelUsage` keys; OTel `model`; mod `turn.step` | message `provider`/`model`; `SingleResult.resolvedModel`; `session_init.resolvedModel`; RPC `get_state` |
| Report usage | Full in `-p` (`modelUsage`), with the mod tier, or with user-configured OTel. Partial from transcripts alone (§10.3). | Full: per-message `usage` with cache and cost; `model_usage` side calls; `SingleResult.usage`; advisor transcripts |
| Rewrite tool output | `updatedToolOutput` (all tools, schema-checked); mod `session.append` | `tool_result` |
| Enforce hard budget | `-p --max-budget-usd`; in-session via tool denial plus Stop | `--max-time`; `task.softRequestBudget`; in-session via `tool_call` block plus `session_stop` |
| Observe advisor consultation | transcript usage `iterations[]` with `type: "advisor_message"` *[verify]*; mod `turn.step` `serverToolUses` | `__advisor*.jsonl` transcripts; `/advisor status`; `omp stats` |

### 5.6 Coexistence with host-native features

| Host feature | Conflict | Rule |
|---|---|---|
| Claude Code `opusplan` alias and `--fallback-model`; omp `--prewalk`, `--plan-yolo`, context promotion, `retry.fallbackChains` | The host switches models independently of Occam | Detect at session start and treat the host's choice as an executor already selected. Record host-initiated switches as `fallbackReason: "host:<feature>"`. Never issue counter-switches. |
| Claude Code auto-compact, Bash output spill (~30,000 chars, then a file path plus a 2,000-char preview), MCP output cap (25,000 tokens by default); omp `pruneToolOutputs`, `shake`, `supersedeReads`, `dropUseless` | Double compression and lost evidence | Occam compresses only new results, before host pruning sees them. Measure each transform's marginal savings with the host feature active, and disable transforms below the configured threshold. |
| Claude Code `CLAUDE.md`, auto-memory, subagent `memory`; omp memory backends (`local`, `hindsight`, `mnemopi`, …), `context_notes`, `AGENTS.md` | Duplicate or conflicting memories injected into context | Occam never writes `CLAUDE.md`, `AGENTS.md`, or host memory. Vault notes are retrieved on demand, never auto-injected. Occam tools must not reuse the names `recall`, `retain`, `reflect`, `memory_edit`, `learn`, `context_notes`, or `new_context`, or the `memory://` scheme. |
| Claude Code advisor; omp advisor/watchdog | Double review cost | §7 |
| omp secret obfuscation (`secrets.enabled`, off by default) | — | Occam's own redaction always runs (§12). Never rely on host redaction. |
| omp reads project `.claude/settings.json` as settings data | Keys written for Claude Code also land in omp's settings layer | Occam does not write host settings by default (§7.2). Any key Occam writes must not collide with an omp setting ID. |

### 5.7 Runtime, paths, and environment

- **Runtimes.** The main plugin runs entirely in-process: the omp extension in omp's Bun runtime, the Claude Code mod inside Claude Code. It needs no `node` or `bun` on `PATH`, which matters because both hosts ship as self-contained executables and the reference workstation has neither (§5.9). Only `occam-compat` (command hooks, MCP server) runs subprocesses. It needs `node` ≥ 22 or `bun` on `PATH`, or must ship compiled executables per platform. Its first hook checks for the runtime and reports degraded mode if it is missing. `occam-core` uses only ECMAScript and Web-standard APIs; filesystem and process access go through adapter-provided interfaces (Claude Code mod `$.fs`; omp's Bun runtime).
- **Hook invocation (`occam-compat`).** Command hooks use exec form (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook.js", "<event>"]`, or a compiled executable path) to avoid shell quoting issues and to work on every platform.
- **Plugin root.** Both hosts substitute `${CLAUDE_PLUGIN_ROOT}` in MCP configuration; omp also accepts `${OMP_PLUGIN_ROOT}`. Neither variable is available in Claude Code's Bash tool environment. In-process entry points resolve their own location from `import.meta`.
- **State directory.** Resolution order: `$OCCAM_STATE_DIR`, then `$XDG_STATE_HOME/occam`, then `~/.local/state/occam`, each with a `<project-id>/` subdirectory. The same path on both hosts lets the index and ledger be shared and lets them survive uninstall. Claude Code's `${CLAUDE_PLUGIN_DATA}` is deliberately not the default: it is Claude-only and is deleted on uninstall unless `--keep-data` is passed.
- **Project root.** Claude Code mod: `cwd` from the `session.start` event (observed in §5.9). `occam-compat` hooks: `CLAUDE_PROJECT_DIR` or the hook input `cwd`. omp extension: `ctx.cwd`. `occam-compat` MCP server: MCP roots when the client provides them, then `CLAUDE_PROJECT_DIR`, then process cwd, then the git top level. omp has no `CLAUDE_PROJECT_DIR` equivalent.
- **Session ID.** Claude Code mod: `$.session.id()` (observed in §5.9); `occam-compat` hooks: hook input `session_id`. omp: `ctx.sessionManager.getSessionId()`.
- **Telemetry variables.** Claude Code strips `OTEL_*` variables from hook and MCP subprocesses. Occam therefore cannot discover the user's OTel exporter from a hook.
- **Settings validation in print mode.** `claude -p` silently ignores settings files that fail validation. `occam-run` validates every `--settings` payload before launch.
- **Concurrency.** Both hosts, and several sessions of each, may share one project state directory. Index writes take an exclusive lock with a bounded wait; the ledger is append-only (§10.4).

### 5.8 Install, update, uninstall

- Updates: Claude Code changes `${CLAUDE_PLUGIN_ROOT}` per version and needs a restart to apply plugin updates. omp needs a session restart for new extension code.
- Uninstall must leave host settings exactly as they were before install. Occam does not edit host settings by default (§7.2). Any opt-in edit is journaled with a backup and reverted by `/occam-setup --revert`.
- The state directory survives uninstall by design. `occam purge [--project <id>]` removes it.

### 5.9 Verification evidence (2026-10-12)

A throwaway probe plugin with the §5.2 layout was installed from one local marketplace into isolated configurations of both hosts (`CLAUDE_CONFIG_DIR` and `OMP_PROFILE`), then removed. The probe contained a skill, a command, an agent with `model: haiku`, a `hooks/hooks.json` `SessionStart` command hook, and a `package.json` `omp.extensions` entry whose extension registered a command plus `session_start` and `before_subagent_spawn` handlers. No subagent was spawned, so `before_subagent_spawn` was not exercised. No model requests were billed: the Claude Code run used a placeholder API key and reported `total_cost_usd: 0`, and the omp check used RPC introspection only.

| Check | Claude Code 2.1.295 | omp 18.10.1 |
|---|---|---|
| `claude plugin validate --strict` (plugin) | Passed, with `package.json` and the omp extension present | n/a |
| `claude plugin validate --strict` (marketplace) | Failed only on the missing marketplace `description` (warning promoted to error) | n/a |
| Install from `.claude-plugin/marketplace.json` | Passed | Passed |
| Skill loaded | `jev-probe-skill` | `skill:jev-probe-skill` |
| Command loaded | `probe` (listed under Skills) | `jev-probe:probe` |
| Agent loaded | `occam-fast` | Not checked; docs: loaded with `model` discarded |
| `hooks/hooks.json` `SessionStart` command hook | Ran | Did not run (expected) |
| `package.json` `omp.extensions` | Not executed (expected) | Loaded: factory ran, `session_start` fired, command `jev-probe-ext` registered, no `extension_error` frames |
| Always-on footprint | `claude plugin details`: ~31 tokens for one skill, one command, one agent | Not measured |
| JS runtime on `PATH` (reference workstation) | Not found at probe time: no `node` or `bun`; `claude` is a self-contained binary. Node was installed later with nvm, which does not change the design: other users' machines may lack it. | Not found at probe time; `omp` is a self-contained binary |

A second Claude Code probe exercised the mod tier the same way (isolated `CLAUDE_CONFIG_DIR`, placeholder key, no billed requests). Its `hooks/hooks.json` contained only `{"modules": ["./register.js"]}`, and its `session.start` hook called `$.tool.register` and wrote a marker through a closure port over `$.fs.write`:

| Check | Result |
|---|---|
| First version, which read `$` as a value (`Object.keys($)`) | `claude plugin validate` failed; at runtime: `hooks module … failed to load: … $ itself is passed as an argument` |
| Corrected version, `claude plugin validate --strict` | Passed; listed `hooks: session.start` and `calls: $.fs.write, $.tool.register` |
| Load in `claude -p` | `hooks module … loaded (worker, environment 1, tier user)` |
| `session.start` | Ran before the API request; event keys `cwd`, `surface`, `isInteractive` |
| `$.tool.register` | Succeeded |
| `$.fs.write` through a closure port passed to non-mod code | Succeeded |
| `claude plugin details` for a mod-only plugin | Reported `Hooks (0)` and `~0 tok` always-on: mod hooks are not counted there |
| Rollout gating | Debug log: modules were held for the rollout flag `tengu_plugin_hooks_modules` before loading. Mod availability therefore depends on a server-side flag *[inference]*, and the capability probe must confirm that the mod actually loaded. |

A third probe and the phase-0 conformance suite (`npm run conformance`, §15.4) established the following:

| Check | Result |
|---|---|
| Mod `$.session.id()`, `$.session.cwd()`, `$.session.version()` | Methods. They return the session UUID, cwd, and `{ version, base, builtAt }` |
| Mod `$.plugin.name`, `$.plugin.root` | Properties, not methods |
| Mod `$.fs.write` to a path whose directories do not exist | Creates the directories |
| Mod `$.process.run` | Takes one argv array (`['mkdir', '-p', dir]`), not `(command, args)` |
| Mod `$.env.get` | Works; `claude plugin validate` lists every env name the mod reads |
| `claude -p "/occam-status"` with the built plugin | Answered by the mod: `num_turns: 0`, `total_cost_usd: 0` |
| omp RPC prompt `/occam-status` with the plugin installed | Answered by the extension through a `notify` UI frame; no model turn |
| `omp --plugin-dir plugins/occam` | Extension **not** loaded; the prompt fell through to the model (401 on the placeholder key) |
| `omp -e plugins/occam/dist/omp-extension.js` | Extension loaded |

Not covered yet: model invocation of mod-registered tools, the `occam-compat` MCP server, and `before_subagent_spawn` routing. These need billed requests.

## 6. Executor routing and switching constraints

### 6.1 Router interface and capability registry

The following is an Occam application interface, not a native host API:

```ts
export interface ExecutorCapabilities {
  host: HostId;
  hostVersion: string;
  mode: Mode;
  activeAdapterTier: "mod" | "command_hooks" | "extension" | "headless" | "advisory_only";
  canLaunchSession: boolean;
  canResumeSession: boolean;
  canDispatchSubagent: boolean;
  canSelectSubagentModel: boolean;
  canSwitchPrimaryModelInSession: boolean;
  canReportActualModel: boolean;
  usageFidelity: "full" | "partial" | "none";
  canRewriteToolOutput: boolean;
  canEnforceHardBudget: boolean;
  canObserveAdvisorConsultation: boolean;
  tierSelectors: Record<Tier, string | null>; // null when the tier cannot be served on this host
  detectedAt: string;
  evidence: Record<string, string>; // capability -> probe that established it
}

export interface ExecutorRouter {
  capabilities(): Promise<ExecutorCapabilities>;
  dispatch(input: {
    decision: RouteDecision;
    task: string;
    context: ContextPackage;
  }): Promise<ExecutionResult>;
}
```

Capabilities are established by runtime probes (host version, which adapter tier fired, model catalog/allowlist queries, observed usage fields) and recorded with their evidence. A capability without evidence is `false`. A capability that is documented but unprobed is `false` until the first observation, and `stopOnUnknownCriticalCapability` decides whether that blocks the task (§13).

### 6.2 Supported patterns

Use, in order of practical suitability:
1. **Headless session per stage** (orchestrated mode) with an explicit model. Authoritative selection and usage; cold cache.
2. **Subagent with an Occam-selected model.** Claude Code: mod `agent.spawn`, or a tier agent whose frontmatter `model` matches the tier. omp: `before_subagent_spawn`. Subagents start with fresh context and no parent cache, so pass a `ContextPackage`, not a transcript.
3. **In-session per-request model override.** Claude Code mod `turn.step`; omp `pi.setModel`. Only when the expected savings exceed the cache re-warm cost (§9.5).
4. **Optional external model adapter**, when intentionally configured, with separate authentication, permission, context, and usage handling. Occam's own side calls already use one (§6.4); routing host stages to it is a separate, unmade decision.

Do not infer that changing a settings file changes the model of an in-flight request. Do not rely on undocumented hooks, private internals, or undocumented commands as a required production path.

### 6.3 Route result

```ts
export interface ExecutionResult {
  taskId: string;
  stageId: string;
  host: HostId;
  mechanism: RouteDecision["mechanism"];
  tier: Tier;
  status: "succeeded" | "failed" | "cancelled" | "blocked";
  requestedModel: string;
  actualModel: string | null;
  modelsUsed: string[]; // every concrete model observed during the stage, in order
  modelConfirmation: "confirmed" | "reported_by_adapter" | "unknown";
  output: string;
  changedFiles: string[];
  toolErrors: string[];
  usage: UsageRecord[]; // disjoint records (§10.1)
  fallbackReason: string | null;
  verification: VerificationResult;
}
```

`confirmed` requires a per-request host record: Claude Code transcript `message.model`, subagent `resolvedModel`/`modelsUsed`, `-p` `modelUsage`, or mod `turn.step`; omp message `model`/`provider` or `SingleResult.resolvedModel`. A tier chosen by policy, or a selector passed to the host, is not proof of the model that ran.

Claude Code subagent results report `usage`/`totalTokens` for the subagent's **final API request only**. Never use them as subagent totals; use the subagent transcript, `-p` `modelUsage`, or mod `turn.step` records instead.

### 6.4 Occam's own model calls (OpenRouter)

Decision (2026-10-12): Occam's own model calls go to OpenRouter. The hosts keep their own providers, so Claude Code and omp stay on the user's Claude subscription.

- **Scope:** the LLM classifier (§4.3), semantic extraction (§8.1), model-generated compression summaries (§9), and diagnostics. Host stages, subagents, and the advisor never go through it.
- **Key:** `OCCAM_OPENROUTER_API_KEY` when set; otherwise the key saved by `/occam-openrouter setup`. Occam ignores `OPENROUTER_API_KEY`, which omp reads to enable its own OpenRouter provider, so Occam's key can never turn into an omp model provider. A key set for other tools also never starts sending code to OpenRouter without an explicit opt-in. Without a key, Occam's model calls are off and every feature that needs them uses its heuristic or deterministic path. A dedicated key can carry an OpenRouter credit limit, which caps Occam's spend separately from the hosts.
- **One-command setup:** `/occam-openrouter setup` works the same on both hosts and stores one key that both read.
  - **Entry:** on omp, a `ctx.ui.input` dialog; on Claude Code, a mod pane with an `Input` field. Neither is a prompt, so the key stays out of transcripts and prompt history. Neither host offers masked entry to plugins (omp masks only provider-login prompts), so the key is visible while typed. Other installed Claude Code mods can observe `ui.input` events.
  - **Validation:** the key is checked against OpenRouter's free `GET /api/v1/key` and saved only if accepted.
  - **Storage:** `credentials.json` in Occam's config directory (`$OCCAM_CONFIG_DIR`, else `$XDG_CONFIG_HOME/occam`, else `~/.config/occam`). The directory is made 0700 and the file 0600 before the key is written; when that fails, nothing is saved. The omp extension uses `fs` with modes. The Claude Code mod creates the file empty, runs `chmod` through `$.process.run`, then writes, relying on `$.fs.write` replacing content in place, which conformance confirmed on 2026-10-12. On Windows, protection rests on the profile's ACLs.
  - **Removal and print mode:** `/occam-openrouter remove` deletes only the OpenRouter entry. Print mode (`claude -p`) cannot show the pane, so `setup` there points to an interactive session or the environment variable.
- **Transport:** OpenRouter's chat completions API through each adapter's HTTP primitive: Claude Code mod `$.http.fetch(url, init)`, omp extension `fetch`. `occam-core` builds requests and parses responses but performs no I/O.
- **Privacy routing:** every request sends `provider: { data_collection: "deny", zdr: true }`. Only endpoints that neither collect data nor retain prompts are eligible. `anthropic/claude-haiku-5.5` had 6 ZDR endpoints out of 10 on 2026-10-12.
- **Models:** tier models are undecided. Until they are chosen, every side call uses `anthropic/claude-haiku-5.5`; pick per-purpose models once the ledger can compare cost and quality.
- **Accounting:** OpenRouter returns usage and cost in every response. Records are `executorRole: "side_call"`, `costBasis: "provider_reported"`, `source: "occam:openrouter"`. `prompt_tokens` includes cached tokens, so uncached input is derived by subtraction *[verify cache-write inclusion on the first live call]*.
- **Diagnostics:** `/occam-openrouter` on both hosts checks the model's endpoints and ZDR coverage plus the key's source, validity, limit, and monthly use, all through free endpoints. `/occam-openrouter live` adds one test completion of a few tokens. OpenRouter answers an invalid key with "Missing Authentication header" and a request without the header with "No cookie auth credentials found"; the report explains this.

## 7. Advisor policy

### 7.1 Backends

| | Claude Code native advisor | omp advisor runtime |
|---|---|---|
| Mechanism | Server-side Anthropic tool; the advisor receives the full conversation, including tool calls and results | Client-side reviewer agent(s) that receive transcript deltas (after the secret obfuscator) and inject `<advisory>` notes through an `advise` tool |
| Who decides when | The executor model. No setting caps or forces calls. | The host schedule: `advisor.reviewMode` (`turn` or `agent-end`) and `advisor.reviewInterval` |
| Configuration | `advisorModel: "opus"` in settings; `/advisor opus` (saves to user settings); `--advisor opus` (per session, absent from `--help`) | `advisor.enabled: true`; `modelRoles.advisor`; `--advisor`; `/advisor on\|off\|status`; `WATCHDOG.yml` rosters |
| Constraints | Anthropic API only (not Bedrock, Vertex/Agent Platform, Foundry, or Claude Platform on AWS); main model must be supported; the advisor must rank at or above the main model; a refused pairing is silently dropped until `/clear` or `/compact`; off when feature-flag fetching is disabled (e.g. `DISABLE_TELEMETRY`); `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` disables it | Any provider; forced off in subagents unless the agent opts in (`advisor: true` or `task.agentAdvisor`); starts disabled under RPC/ACP hosts |
| Consultation evidence | Transcript usage `iterations[]` entries with `type: "advisor_message"` and their `model` *[verify: `iterations[]` is present in local transcripts, but no consultation sample exists]*; mod `turn.step` `serverToolUses`. Settings hooks, the statusline, and OTel expose no advisor fields. | `__advisor*.jsonl` transcripts in the session directory; `/advisor status`; `advisor_cost_changed`/`advisor_yielded` events; `omp stats` |
| Usage | In `iterations[]`; top-level `usage` covers the executor only; `/usage` totals include the advisor | Advisor transcript usage; per-session advisor cost ledger |

### 7.2 Configuration policy

**Claude Code**
- Occam does not write `advisorModel` by default, and plugin `settings.json` cannot set it.
- Default (`applyMethod: instruct_user`): `/occam-setup` checks the effective setting and, if it is missing, asks the user to run `/advisor opus`.
- `applyMethod: launcher_flag`: `occam-run` passes `--advisor opus` to each headless session.
- `applyMethod: settings_local_write` (opt-in): merge `advisorModel` into `.claude/settings.local.json` only. Take a backup and journal the change first; preserve all other keys; reject the write on validation failure. Never write managed settings. Never write the committed `.claude/settings.json` unless the user explicitly asks: it changes teammates' sessions and is also merged into omp's settings layer.
- Occam must never set environment variables that disable feature-flag fetching (such as `DISABLE_TELEMETRY`) in sessions where the advisor is wanted.

**omp**
- For advisor-worthy stages, the extension may enable `advisor.enabled` and set `modelRoles.advisor` (and `advisor.reviewMode: agent-end` for lower cost) through the runtime override layer. That layer is never persisted, and Occam uses it only when `isConfigured()` reports that the user has not set the key.
- Persistent changes are made only by the user (`/advisor`, `config.yml`).

### 7.3 Separate state fields

Maintain these distinct fields:
- `advisorBackend`: `claude-native` | `omp-runtime` | `explicit-review-stage` | `none`;
- `advisorConfigured`: configuration resolves to the intended model;
- `advisorAvailable`: the version, provider, model pairing, and policy permit the feature (`null` when undeterminable);
- `advisorConsultationStatus`: `confirmed` | `not_confirmed` | `unknown`;
- `advisorModelResolved`: resolved model ID if the host exposes it, otherwise `null`.

A configured advisor is not necessarily available. Availability is not proof of invocation. Invocation is not proof that the result was correct.

### 7.4 Decision-point guidance

Occam marks a decision advisor-worthy when it involves:
- architectural alternatives with material long-term cost;
- ambiguous requirements with costly consequences;
- high-impact or broad refactors;
- security-sensitive implementation choices;
- repeated failed attempts or a stalled task;
- unresolved trade-offs that could cause substantial rework;
- a final high-risk review when the workflow explicitly requires one.

Routine retrieval, mechanical edits, simple formatting, and deterministic indexing do not require an advisor consultation by default.

- **Claude Code:** Occam can only encourage a consultation, with a short hint injected at the boundary. It must not claim the advisor will run.
- **omp:** Occam can enable the advisor for the stage (§7.2).
- **Guaranteed review:** when policy requires one, dispatch an explicit review stage on the `deep` tier and record its actual model and result.

### 7.5 Compatibility and degraded mode

At session start, determine the host, version, provider, main-model/advisor pairing, model allowlists, and advisor setting from runtime evidence. Do not consult documentation at runtime; ship the pairing rules in the versioned capability registry.

If unavailable:
- set `advisorAvailable: false` and record the reason when known (unsupported provider, invalid pairing, disabled by environment, policy);
- if Claude Code shows a configured advisor but no `advisor_message` appears across N advisor-worthy turns, report `not_confirmed`. Do not infer unavailability, because pairing refusal is silent;
- continue without the advisor if task policy permits;
- for tasks requiring independent review, dispatch an explicit review stage or stop and escalate;
- never claim an Opus consultation occurred without evidence.

## 8. Knowledge graph and Obsidian vault

### 8.1 Graph contents and extraction

Prefer deterministic extraction (tree-sitter grammars for symbols, definitions, and imports; LSP where a server is available; ctags as a fallback) for:
- repository files and directories;
- language-level symbols and definitions;
- imports and dependency edges;
- test-to-source relationships where detectable;
- call/reference edges where extraction is reliable;
- ownership, working-tree content hashes, commit IDs, and index timestamps.

The capability registry declares which languages each extractor supports. Files in unsupported languages get file-level nodes only.

Use semantic/LLM extraction only for relationships that syntax does not reliably capture, such as conceptual flows, architectural intent, or domain entities. Run it through Occam's OpenRouter client (§6.4), attribute it to the `semantic_extraction` purpose, and store confidence and provenance for every semantic edge.

### 8.2 Storage

- The system of record is a content-addressed file store that needs only file I/O, so the same store works in omp's Bun runtime, the Claude Code mod runtime, and the optional `occam-compat` MCP subprocess:
  - `<state-dir>/<project-id>/index/manifest/<shard>.json` maps path → content hash, language, and index version. Shards are keyed by a path hash and stay below 4 MiB (§5.2);
  - `index/files/<hash-prefix>/<content-hash>.json` holds the symbols, imports, and edges extracted from one file version;
  - `index/symbols/<shard>.jsonl` is a sharded inverted index (symbol name → content hashes), rewritten per shard.

  A source change rewrites one file record, the affected shards, and the manifest, so indexing stays incremental. Readers never lock; writers take the project lock.

  The Claude Code mod's `$.fs` has no rename or delete, and `$.fs.write` is documented as non-atomic. The mods docs point multi-session data at `$.store`, which omp cannot read. Writers in every tier therefore use self-validating files: each file embeds a checksum of its content, and readers discard torn files. Manifest shards are generation-numbered, and readers take the newest valid generation. Pruning old generations runs in the omp extension or through mod `$.process.run` argv calls. Settle the exact scheme in phase 6.
- A runtime that provides SQLite may build a disposable acceleration cache from the file store (`knowledge.indexAccelerator: sqlite`). It is rebuilt from the file store whenever versions disagree and is never the system of record. Native addons are not allowed in `occam-core`.
- A `graph.json` export is optional (`knowledge.exportGraphJson`) for inspection or Obsidian plugins. It is never the system of record, because rewriting one large JSON file on every change is not incremental.
- Project ID: a hash of the canonical git remote URL (or the absolute root path when there is no remote) plus the repo-relative root. Worktrees share the project ID but keep separate freshness state, because their content hashes differ.

### 8.3 Vault location and layout

Default location: `<state-dir>/<project-id>/vault/`, outside the repository. An in-repo vault (`knowledge.vaultLocation: repo`, e.g. `./OccamVault`) is opt-in and must be:
- excluded from the graph index;
- listed in `.gitignore`, unless the team deliberately commits it;
- excluded from host search tools. Both hosts' search tools respect `.gitignore` by default *[inference for Claude Code]*. A committed vault needs explicit exclusion, or every grep will return note matches.

```text
<vault>/
  Project-Map.md
  Architecture/
  Modules/
  Flows/
  Decisions/
  Conventions/
  Entities/
  Pitfalls/
```

Note frontmatter (Obsidian properties):

```yaml
---
occam_id: note-01J9Z8K3QX
title: Request retry policy
type: flow            # module | flow | decision | convention | entity | pitfall | architecture
sources:
  - path: src/http/retry.ts
    symbol: RetryPolicy.next
    content_hash: sha256:5f1c…
commit: 3e1a9c2       # or null
confidence: high      # high | medium | low
provenance: deterministic   # deterministic | semantic | user
freshness: fresh      # fresh | stale | unverified
created: 2026-10-12T09:00:00Z
updated: 2026-10-12T09:00:00Z
tags: [http, retries]
---
```

Note filenames are the `occam_id`, so titles can repeat without collisions. Links use Obsidian wikilinks in the form `[[occam_id|Title]]`.

### 8.4 Freshness and authority

- Repository source and current tool output are authoritative.
- Freshness is decided by working-tree content hashes. Commit IDs alone miss uncommitted edits, branch switches, and rebases, and timestamps alone prove nothing.
- Invalidate affected notes and graph rows when source changes:
  - Claude Code (mod tier): edit-tool results via `tool.call`/`session.append`. After Bash results, mark the working tree dirty and re-hash lazily at the next retrieval *[verify whether the mods API exposes a file-change event]*.
  - Claude Code (`occam-compat`): `FileChanged` (a filesystem watcher that also catches Bash and external writes; armed with `watchPaths` from `SessionStart`), plus `PostToolUse` on edit tools.
  - omp: `tool_result` on edit/write tools. After `bash` results, mark the working tree dirty and re-hash lazily at the next retrieval.
- If a note conflicts with current source, ignore it for the current task, flag it stale, and queue re-indexing.
- Avoid full rebuilds for localized changes; update changed files and impacted graph edges.

### 8.5 Occam retention gate

Every candidate memory is classified as one of:
- `keep`: durable, reusable, sufficiently grounded;
- `update`: replace or revise a stale note;
- `merge`: consolidate duplicate or overlapping notes;
- `defer`: potentially useful but insufficiently verified or currently irrelevant;
- `discard`: transient, redundant, speculative, sensitive, or low-value.

Do not store secrets, credentials, access tokens, private keys, or unnecessary personal data in the vault. Store only project-relevant knowledge allowed by the user's source and privacy constraints.

**Persistent-injection defense.** Notes are re-injected into future sessions, so text that enters the vault outlives the session that produced it. The gate:
- stores repository and tool-output text as quoted excerpts with provenance, never as instructions;
- strips imperative text aimed at agents;
- never promotes content from tool output, web results, or third-party files into `Conventions/` or `Decisions/` without user confirmation.

### 8.6 Retrieval sequence and tool surface

1. Read the compact project map (on demand; at most `knowledge.sessionStartInjectionMaxTokens` is injected at session start, default 300).
2. Query graph nodes related to task terms, symbols, and flows.
3. Retrieve the smallest relevant note set.
4. Verify freshness.
5. Inspect targeted source files and relevant tests.
6. Build a bounded `ContextPackage` with citations/paths and uncertainty labels.
7. After execution, update only knowledge that passes the retention gate.

The knowledge service exposes at most three tools, with short descriptions. They are registered in-process (Claude Code mod `$.tool.register`; omp `pi.registerTool`) or, under `occam-compat`, served by the MCP server:
- `occam_context(task, budget)` returns a `ContextPackage`;
- `occam_lookup(ref)` resolves a symbol, path, or note ID;
- `occam_remember(candidate)` submits a candidate to the retention gate.

On Claude Code, MCP tool search may defer mod-registered tools, so Claude sees the name but not the description until it searches. Occam keeps deferral for `occam_lookup` and `occam_remember` to cut the always-on footprint, and sets `isDeferred: false` (2.1.293+) only on `occam_context` if route compliance shows Claude is not finding it.

## 9. Context compression

### 9.1 Preservation rules

Compression may remove repetition, not evidence. Preserve:
- user requirements and acceptance criteria;
- permissions and safety constraints;
- exact failing commands, error messages, exit codes, and relevant stack frames;
- changed-file summaries and relevant diffs;
- test results and unresolved failures;
- source paths, line/symbol references, and provenance;
- uncertainties and decisions still pending.

For long tool outputs:
- keep the first/last lines when they contain context or summary;
- preserve all error blocks and the relevant surrounding lines;
- extract structured fields before summarizing prose;
- store a pointer to the full output, reusing the host's own spill file when one exists (Claude Code `tool-results/` files and Bash spill paths; omp `artifact://` URIs);
- never summarize away an unknown or failure as success.

Every compressed output states whether it is exact, extracted, or model-generated. Do not feed the same large output into multiple stages when a compact referenced summary is sufficient and reliable.

### 9.2 Mechanisms

| Host | Mechanism | Constraints |
|---|---|---|
| Claude Code (mod) | `session.append` | Rewrites the stored `tool_result` content of the row being appended. Apply at append time only. |
| Claude Code (`occam-compat`) | `PostToolUse` → `updatedToolOutput` | The value must match the tool's output shape, or it is silently ignored. The adapter validates the shape and records `compression: rejected` on mismatch. Telemetry still records the original output. |
| Claude Code (`occam-compat`) | `PreToolUse` → `updatedInput` | Rewrite allowlisted commands only (e.g. wrap a test runner with a filter). Preserve the exit code and keep full output retrievable. |
| omp | `tool_result` → `{ content, details, isError }` | Middleware chain; Occam runs as one stage of it. |
| omp | `context` event → `{ messages }` | Per-request view; persisted history is unchanged. Avoid it outside compaction boundaries, because it alters the cached prefix (§9.5). |

### 9.3 Determinism and cache safety

- Transforms are pure functions of (tool name, tool input, raw output, transform version), so retries produce byte-identical results.
- Transforms apply only when a result is first inserted. Previously sent messages are never rewritten except through the host's own compaction.
- Each transformed result records `fidelity` and `transformVersion` in the ledger.

### 9.4 Measuring compression

For each transform, record:
- tokens saved, estimated with a tokenizer, before vs. after;
- the re-fetch rate: the same file or command re-read within N turns, used as a proxy for over-compression;
- the marginal savings with host pruning active (§5.6).

A transform with negative net effect, or with marginal savings below the configured threshold, is disabled automatically and reported.

### 9.5 Prompt-cache economics

- Anthropic prompt caching bills cache reads at a fraction of base input and cache writes at a premium; 5-minute and 1-hour TTL writes are priced differently. At time of writing these are roughly 0.1× for reads, 1.25× for 5-minute writes, and 2× for 1-hour writes. Load the actual multipliers from the versioned pricing registry; never hard-code them.
- Caches are per model. Switching model mid-session re-writes the entire prefix at the new model's write price. Claude Code's `PreModelSwitch` input exposes `prompt_cache_warm` and `estimated_cache_write_usd`; omp exposes warming economics through `cache_warming_decision`.
- Route cost estimate: `expected_stage_tokens × price(model) + rewarm_cost (if the model differs from the warm prefix) + context_package_cost`. An in-session switch is allowed only when expected savings exceed the re-warm cost by the configured safety factor.
- Subagents and headless stages start cold. Their first request pays a cache write for the system prompt, tool schemas, and context package, so small tasks are often cheaper in the warm main session.
- Injected context must be byte-stable for identical inputs (no timestamps or random IDs) and must never be inserted ahead of already-cached content.
- For headless Claude Code stages, `--exclude-dynamic-system-prompt-sections` moves per-machine sections out of the system prompt and improves cross-session cache reuse.
- Idle gaps longer than the cache TTL expire the cache. A main session that waits on a long subagent may lose its cache *[inference]*. Include this in the cost model for long delegated stages.

## 10. Token accounting and budget enforcement

### 10.1 Dimensions

The original category list overlapped (retry and subagent usage are also executor input/output), which double counts. Every usage record therefore carries exactly one value on each of these dimensions:

- **Token kind:** uncached input; output (including reasoning/thinking); cache read; cache write (with a 5-minute/1-hour split when reported).
- **Executor:** host, concrete model, provider, and role (`main`, `subagent`, `advisor`, `headless_stage`, `side_call` for titles, compaction, cache warming, or memory).
- **Purpose:** exactly one of `execution`, `retry`, `verification`, `review`, `routing`, `retrieval`, `compression`, `indexing`, `semantic_extraction`, `compaction`, `advisor`, `host_overhead`.

Totals are sums over disjoint records. Provider-reported monetary cost is a field of each record, not a separate category.

### 10.2 Usage record

```ts
export type Purpose =
  | "execution" | "retry" | "verification" | "review" | "routing" | "retrieval"
  | "compression" | "indexing" | "semantic_extraction" | "compaction" | "advisor" | "host_overhead";

export interface UsageRecord {
  recordId: string; // dedupe key: host request/message ID
  host: HostId;
  model: string | null;
  provider: string | null;
  executorRole: "main" | "subagent" | "advisor" | "headless_stage" | "side_call";
  purpose: Purpose;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null; // subset of outputTokens when reported
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWriteBreakdown: { ttl5m: number | null; ttl1h: number | null } | null;
  serverToolUses: Record<string, number> | null; // e.g. web_search, advisor
  estimatedCost: number | null;
  actualCost: number | null;
  costBasis: "provider_reported" | "host_estimate" | "occam_estimate" | null;
  pricingVersion: string | null;
  currency: string | null;
  usageStatus: "provider_reported" | "partially_reported" | "estimated" | "unavailable";
  source: string | null; // e.g. "claude:mod.turn.step", "claude:p.modelUsage", "claude:transcript", "omp:message_end"
  observedAt: string;
}
```

Null means unknown or not reported; zero means measured zero. Do not manufacture per-model or advisor values the host does not expose. Advisor usage is recorded as separate `executorRole: "advisor"` records. If it cannot be separated, the affected totals are `partially_reported`.

### 10.3 Host usage sources and pitfalls

**Claude Code**
- `claude -p --output-format json`: `modelUsage` is per model and includes subagents and compaction. It is authoritative for orchestrated stages. Top-level `usage` covers the main loop only. `total_cost_usd` is a client-side estimate (`costBasis: host_estimate`).
- Mod `turn.step`: per-request `usage` and model. Authoritative in interactive mode when the mod tier is active.
- Transcripts (`~/.claude/projects/<project>/<session>.jsonl`; subagents under `<session>/subagents/agent-<id>.jsonl`):
  - one API response spans several entries that share `message.id`; dedupe by that ID;
  - input and cache counts are reliable;
  - per-message `output_tokens` is a placeholder captured at response start (documented for SDK messages, which Claude Code builds the same way *[verify for transcripts]*), so transcript-only output totals are `partially_reported`;
  - entries with `model: "<synthetic>"` are not API usage.
- Subagent results: `usage`/`totalTokens` cover the final request only (§6.3).
- OTel (`claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.api_request` with `model` and `query_source`): available only when the user enables it (`CLAUDE_CODE_ENABLE_TELEMETRY=1` plus an exporter). Third-party plugin and agent names are redacted unless `OTEL_LOG_TOOL_DETAILS=1`. Occam may read an exporter the user configured but never enables telemetry itself.
- The statusline reports session totals for the current model only. Use it for display, never for attribution.

**omp**
- `message_end` and session JSONL assistant messages: `usage { input, output, cacheRead, cacheWrite, totalTokens, cost { … } }` plus `model` and `provider`. There is no TTL split, so `cacheWriteBreakdown` is `null`.
- `model_usage` session entries: side calls with a `purpose` (e.g. cache warming).
- Task `SingleResult.usage`; child transcripts in the parent session's artifacts directory.
- Advisor usage: `__advisor*.jsonl`.
- Cost is an omp estimate from catalog pricing (server-reported cost is preferred when available) and is never repriced later. Unknown pricing is recorded as `0`. Occam records such a cost as `null` unless the catalog entry has non-zero prices or the provider is known to be free.

Each usage parser must document whether tool output is included in input usage and must avoid double counting across stages, subagents, and transcripts.

**Occam side calls (OpenRouter, §6.4)**
- Every chat completion response carries `usage { prompt_tokens, completion_tokens, completion_tokens_details.reasoning_tokens, prompt_tokens_details.{cached_tokens, cache_write_tokens}, cost }` and the serving `model` and `provider`. `cost` is the provider-reported charge in USD.
- The response `id` is the generation ID and serves as `recordId`.

### 10.4 Stage ledger

```json
{
  "taskId": "task-001",
  "stageId": "stage-003",
  "host": "omp",
  "mode": "interactive",
  "policyVersion": "occam-routing-v2",
  "tier": "standard",
  "mechanism": "subagent",
  "requestedModel": "@default",
  "actualModel": null,
  "modelConfirmation": "unknown",
  "advisorBackend": "omp-runtime",
  "advisorConfigured": true,
  "advisorAvailable": null,
  "advisorConsultationStatus": "unknown",
  "usage": [
    {
      "recordId": "msg_example",
      "host": "omp",
      "model": null,
      "provider": null,
      "executorRole": "subagent",
      "purpose": "execution",
      "inputTokens": null,
      "outputTokens": null,
      "reasoningTokens": null,
      "cacheReadTokens": null,
      "cacheWriteTokens": null,
      "cacheWriteBreakdown": null,
      "serverToolUses": null,
      "estimatedCost": null,
      "actualCost": null,
      "costBasis": null,
      "pricingVersion": null,
      "currency": null,
      "usageStatus": "unavailable",
      "source": null,
      "observedAt": "2026-10-12T00:00:00Z"
    }
  ],
  "retryCount": 0,
  "fallbackReason": null,
  "outcome": "pending"
}
```

The timestamp above is an example value. Runtime records use the actual observation time.

Storage: append-only JSONL under `<state-dir>/<project-id>/ledger/<yyyy-mm>.jsonl`, written with `O_APPEND`, one record per line, deduplicated on read by `recordId`. Retention is configurable (default 90 days). Prompt text is not stored by default; records hold hashes and rule IDs.

### 10.5 Budgets

Maintain:
- **Hard budget:** maximum allowed spend, tokens, or time. When reached, stop safely, summarize progress, and preserve a checkpoint.
- **Soft budget:** trigger cheaper eligible routing, tighter retrieval, compression, fewer redundant calls, and a review of remaining work.
- **Verification reserve:** reserve budget for required tests, review, and final reporting. Do not spend the entire budget on implementation.

Enforcement:
- **Orchestrated:** Claude Code `--max-budget-usd` per stage; omp `--max-time` per stage. `occam-run` checks the ledger between stages.
- **Interactive:** at the hard budget, deny further tool calls with a reason that tells the model to summarize and stop (Claude Code `PreToolUse` `permissionDecision: "deny"` or mod `tool.call` `{ deny }`; omp `tool_call` `{ block: true, reason }`). The Stop / `session_stop` handler writes the checkpoint. A request already in flight cannot be interrupted, so overshoot is bounded by one request and is reported.

Use conservative, labeled estimates when usage is not available. If neither usage nor cost can be estimated reliably, enforce the budget through observable limits (stage count, retries, elapsed time) and disclose the limitation.

### 10.6 Plugin footprint budget

- **Always-on footprint:** skill, command, and agent descriptions, MCP tool schemas, and session-start injection. Default budget: 1,500 tokens.
  - Claude Code: measured with `claude plugin details occam` ("Always-on" projected cost).
  - omp: measured by tokenizing the same strings (`omp toks`).
- **Per-turn injection** (prompt-submit or tool-hook `additionalContext`): default budget 0 tokens. Injection happens only when a decision boundary fires.
- Claude Code caps each hook `additionalContext`/`systemMessage` at 10,000 characters and spills longer text to a file; Occam's injections stay far below that.
- The footprint counts as Occam overhead (`host_overhead`) in every savings calculation.

### 10.7 Evaluation formulas

Tokens are not fungible across models or token kinds, so the primary savings metric is cost at a fixed pricing version. Tokens are reported as a per-model vector of (input, output, cache read, cache write), never as one scalar.

- **Occam cost per task** = execution + overhead (routing, retrieval, compression, advisor, verification, footprint) + amortized indexing and maintenance.
- **Net savings per task** = `baseline_cost − occam_cost`.
- **Break-even task count** = `initial_indexing_cost / (baseline_cost_per_task − (occam_execution_cost_per_task + maintenance_cost_per_task))`. Defined only when the denominator is positive.
- **Quality-adjusted cost** = total cost divided by the number of tasks that met their acceptance criteria. Failed tasks count toward cost but not toward successes.

These metrics must be computed on comparable workloads, with the same accounting basis and pinned model IDs. Report tokens and cost separately, and include quality, latency, retries, and maintenance overhead. A lower token count alone is not success if correctness falls.

## 11. Fallback and failure policy

| Failure | Behavior |
|---|---|
| Requested model unavailable | Try the next eligible tier in the fixed fallback order; log requested and actual model when known. |
| Requested model blocked by Occam or host allowlist | Do not bypass the restriction; choose an allowed model or stop. |
| High-risk task would fall back to a lower tier | Stop and ask, unless `allowHighRiskDowngrade` is set. Flag it in the report. |
| Primary model cannot be switched in the current request | Use a supported subagent or headless route, keep the current model, or stop with an explicit limitation. |
| Host switched model on its own (fallback chain, `opusplan`, prewalk, context promotion) | Record `actualModel` and `fallbackReason: "host:<feature>"`; do not counter-switch. |
| Claude Code mod tier unavailable | If `occam-compat` is installed and its runtime is present, use the command-hook tier; downgrade capabilities; record it. Otherwise advisory-only mode. |
| All hooks disabled (`disableAllHooks`, `--bare`) | Advisory-only mode: skills, commands, agents (plus `occam-compat` MCP tools if installed). No compression or enforcement. Report it. |
| `occam-compat` runtime missing (`node`/`bun` not on `PATH`, no compiled executable) | `occam-compat` hooks and MCP server cannot start; report it once per session and point to the main plugin's mod tier. |
| omp extension failed to load (`extension_error`, startup log) | Advisory-only mode; report it. |
| `updatedToolOutput` rejected (shape mismatch) | The original output stands; record it and fix the transform. |
| Advisor unavailable | Mark degraded mode; continue only if policy allows. |
| Advisor configured but never confirmed | Report `not_confirmed`; never infer a consultation. |
| Advisor required but not available | Dispatch an explicit `deep`-tier review stage, or pause and escalate. |
| Graph/vault retrieval or MCP server fails | Use bounded, targeted source search and continue with reduced knowledge support. |
| Stored note stale or conflicts with source | Trust current source, flag the note stale, queue a refresh. |
| Usage metrics missing | Record null/unknown; estimate only with a disclosed method. |
| Soft budget reached | Reduce context and optional calls; select a cheaper eligible route where appropriate. |
| Hard budget reached | Stop at a safe checkpoint and report incomplete work. |
| Test or acceptance failure | Diagnose, repair, and re-run relevant verification within retry limits. |
| Repeated lack of progress (§4.6) | Change strategy or tier once according to policy, then stop/escalate. |
| Hook or handler timeout | Claude Code: a `PreToolUse` timeout does not block unless `onFailure: "block"` is set. omp: `tool_call` fails closed after 30 s by default. Occam handlers on tool paths must finish within a few hundred milliseconds and never make network or model calls. Compression fails open; budget and safety guards fail closed, explicitly. |
| Adapter failure | Retry only if transient and safe; otherwise use the configured fallback or stop. |
| Configuration merge/validation failure | Do not overwrite settings; report the error and leave configuration unchanged. In print mode, pre-validate, because `claude -p` silently ignores invalid settings files. |
| State-directory lock contention | Retry with bounded backoff, then continue read-only and report it. |

Default retry limit: **two retries per stage**, configurable by task risk and adapter behavior. A retry may not repeat an identical failed action without a changed hypothesis or a reason to expect a different result. Use idempotency keys where available. High-risk file operations follow existing approval and backup rules.

## 12. Security, privacy, and permissions

- Preserve each host's permission model and explicit user-approval requirements.
- Occam never approves tool calls. Claude Code mods are unsandboxed and can approve calls that an `ask` rule or a user's `PreToolUse` hook would stop, so the Occam mod returns `allow` from neither `tool.check` nor `tool.call`. It may only pass a call through, deny it, or answer its own registered tools.
- Do not automatically enable unrestricted shell, filesystem, network, or credential access.
- Treat repository content, tool output, graph nodes, and vault notes as untrusted data. Do not follow instructions embedded in them that conflict with system policy or user intent. Apply the persistent-injection defense in §8.5.
- **Code-execution trust differs by host:**
  - Claude Code loads project-scope plugins only after workspace trust, and their MCP servers need per-server approval.
  - omp loads project-level inputs without a directory-trust prompt, and its extensions run in-process without a sandbox.
  - Consequently, project `.occam/config.yml` is data only. It contains no code paths or shell snippets, and any verification commands it lists need user confirmation on first use per content hash.
- `claude -p` skips the workspace-trust dialog. `occam-run` refuses directories that are not in Occam's trusted list unless `--trust` is passed.
- Never store credentials, API keys, tokens, private keys, or unrelated personal information in graph/vault notes, ledgers, or logs.
- Occam runs its own redaction (pattern rules plus entropy checks) before every write to the vault, ledger, or logs, and before any `additionalContext`/`systemMessage`. Host redaction (omp `secrets`) is not relied upon.
- Never put untrusted text in Claude Code's `classifierContext`.
- Both advisors see conversation content: the Claude Code advisor receives the full conversation, and the omp advisor receives obfuscated transcript deltas. Data-handling policies must account for this.
- Limit logs to the minimum necessary to diagnose routing and cost; make retention configurable.
- Do not upload source code or context to an external model/provider unless explicitly configured and permitted. For Occam's own calls, setting `OCCAM_OPENROUTER_API_KEY` or running `/occam-openrouter setup` is that opt-in, and requests are restricted to non-collecting ZDR endpoints (§6.4).
- The saved OpenRouter key is plaintext in an owner-only (0600) file, as many CLI credential files are. It never appears in config, logs, ledgers, vault notes, or command output; messages show only a masked prefix and suffix.
- Apply repository and workspace boundaries to all indexing and retrieval operations.
- Protect graph indexes and vault writes against path traversal and unsafe symlink behavior.
- Use atomic writes for any settings, index manifests, and config files; retain a recoverable backup before any settings mutation.
- Use exec-form command hooks (`command` plus `args`) so paths are never interpreted by a shell.

## 13. Configuration contract

Configuration lives in `~/.config/occam/config.yml` (user) and `.occam/config.yml` (project; data only, §12). Project values override user values, except for `security.*`, where the most restrictive value wins. Configuration is validated at startup against a versioned schema with documented defaults.

```yaml
schemaVersion: 2
policy:
  version: occam-routing-v2
  deterministic: true
  maxRetriesPerStage: 2
  maxStagesPerTask: 12
  maxReroutesPerTask: 3
  maxTierEscalationsPerTask: 1
  stopOnUnknownCriticalCapability: true
  featureBuckets:
    complexity: [0.25, 0.5, 0.75]
    uncertainty: [0.25, 0.5, 0.75]
  classifier:
    mode: heuristic_first        # heuristic_only | heuristic_first | llm
    llmTier: fast
    minHeuristicConfidence: 0.7
tiers:
  allowlist: [fast, standard, deep]
  fallbackOrder:
    lowRisk: [fast, standard, deep]
    mediumRisk: [standard, deep]
    highRisk: [deep]
  allowHighRiskDowngrade: false
hosts:
  claude-code:
    tierSelectors: { fast: haiku, standard: sonnet, deep: opus }
    adapterPreference: [mod, compat_plugin]
    inSessionModelSwitch: cache_checked   # never | cache_checked
    cacheSwitchSafetyFactor: 2.0
  omp:
    tierSelectors: { fast: "@smol", standard: "@default", deep: "@slow" }
    inSessionModelSwitch: cache_checked
    cacheSwitchSafetyFactor: 2.0
advisor:
  requiredByDefault: false
  explicitReviewFallback: true
  explicitReviewTier: deep
  confirmationWindowTurns: 5
  claude-code:
    model: opus
    applyMethod: instruct_user           # instruct_user | launcher_flag | settings_local_write
  omp:
    enableForAdvisorWorthyStages: true
    model: "@slow"
    reviewMode: agent-end
knowledge:
  stateDir: null                         # null = resolve per §5.7
  vaultLocation: state_dir               # state_dir | repo
  repoVaultPath: ./OccamVault              # used only when vaultLocation = repo
  indexBackend: files                    # content-addressed file store (§8.2)
  indexAccelerator: none                 # none | sqlite (disposable cache, where the runtime provides SQLite)
  exportGraphJson: false
  incrementalIndexing: true
  sourceIsAuthoritative: true
  sessionStartInjectionMaxTokens: 300
accounting:
  collectProviderUsage: true
  recordUnknownAsNull: true
  treatZeroCostWithUnknownPricingAsNull: true
  pricingRegistry: builtin               # or a path to a versioned pricing file
  hardBudget: { tokens: null, costUsd: null, elapsedMs: null }
  softBudget: { tokens: null, costUsd: null }
  verificationReservePercent: 15
  ledgerRetentionDays: 90
  storePromptText: false
compression:
  enabled: true
  preserveErrorsAndAcceptanceCriteria: true
  applyAtInsertionOnly: true
  minOutputCharsToCompress: 4000
  disableTransformBelowMarginalSavingsPercent: 5
sideCalls:
  provider: openrouter                   # Occam's own model calls only; hosts keep their providers (§6.4)
  apiKeyEnv: OCCAM_OPENROUTER_API_KEY      # wins when set; never stored in config
  credentialsFile: credentials.json      # in Occam's config dir, owner-only; written by /occam-openrouter setup
  model: anthropic/claude-haiku-5.5      # until per-purpose models are chosen
  dataCollection: deny
  zdr: true
footprint:
  alwaysOnTokenBudget: 1500
  perTurnInjectionTokenBudget: 0
  maxMcpTools: 3
security:
  storeSecrets: false
  preserveHostPermissions: true
  editHostSettings: never                # never | with_confirmation
  requireConfirmationForProjectCommands: true
```

This is the Occam configuration schema, **not** a host settings file. Do not paste it into Claude Code `settings.json` or omp `config.yml`. The only host setting this specification touches is the advisor (§7.2). Validate all keys against the implementation schema; reject unknown critical fields and provide clear diagnostics.

Tier selectors and fallback orders are defaults. Review them against current model capability, task quality requirements, current pricing, provider compatibility, and organization allowlists. A low-risk order must not force a less capable model when the task's required capabilities are unavailable on that tier.

## 14. Observability and reporting

Every route decision logs:
- task/stage IDs, policy version, and registry version;
- host, mode, and active adapter tier;
- normalized task features and constraint outcomes, excluding secrets;
- tier, requested selector, actual model if known, and the confidence of that observation;
- mechanism and fallback reason;
- advisor backend and configured/available/consulted states;
- cache state at decision time (warm/cold, estimated re-warm cost);
- context sources and freshness state;
- usage and accounting status;
- verification result, retries, and final outcome.

The final task report includes:
- completed, partially completed, blocked, or failed status;
- files changed and verification performed;
- remaining risks or unverified claims;
- routing, adapter-tier, or advisor degradation;
- route compliance (interactive mode);
- observed tokens/cost per model and whether totals are actual, partial, estimated, or unavailable;
- knowledge updates made or deferred.

Delivery:
- **Both hosts:** `/occam-report` on demand.
- **Automatic, shown to the user without entering model context:** Claude Code mod `turn.complete` (`{ text }` under the answer) or the `occam-compat` `Stop` hook `systemMessage`; omp `ctx.ui.notify` from `session_stop` when a UI exists.
- Do not inject the report into model context unless the user asks, because injection is paid on every later request.

Do not expose hidden reasoning or private chain-of-thought in logs. Store concise decision reasons (rule IDs) and observable evidence instead.

## 15. Testing and acceptance criteria

### 15.1 Unit tests
- identical normalized input, policy version, and capability registry yield an identical route on both hosts;
- quantization boundaries route deterministically (values exactly on a cut point);
- invalid classifier output is rejected or safely normalized;
- model selection respects the Occam and host allowlists and hard constraints;
- high-risk tasks never downgrade without `allowHighRiskDowngrade`;
- unknown usage is not coerced to zero, and omp zero cost with unknown pricing becomes `null`;
- settings merge preserves unrelated fields and is reversible;
- the retention gate handles keep/update/merge/defer/discard correctly and strips agent-directed instructions;
- stale knowledge never outranks current source;
- retry count, global stage/re-route limits, no-progress detection, and the hard-budget stop are enforced;
- compression transforms are idempotent and byte-stable.

### 15.2 Usage-parser tests (fixtures per host version)
- Claude Code transcripts with several entries sharing `message.id` are counted once;
- placeholder per-message `output_tokens` is never reported as `provider_reported`;
- subagent `usage`/`totalTokens` is never treated as a subagent total;
- `-p` `modelUsage` attributes subagent and compaction usage to the correct models;
- omp `message_end`, `model_usage`, `SingleResult.usage`, and advisor transcripts produce disjoint records;
- the advisor `iterations[]` entries become `executorRole: "advisor"` records.

### 15.3 Adapter contract tests
- dispatch records the requested tier and selector;
- the actual model is confirmed only with per-request host evidence;
- unsupported primary-model switching triggers the defined fallback;
- an unavailable subagent or worker returns a clear failure;
- exactly one adapter tier acts per event (mod vs. command hooks);
- `updatedToolOutput` values match each built-in tool's output shape;
- cancellation and partial outputs are represented correctly;
- the same recorded scenario replayed through both adapters yields the same `RouteDecision` sequence.

### 15.4 Host conformance tests (CI, pinned host versions)
- `claude plugin validate --strict` passes for the plugin and the marketplace;
- installing from the marketplace into an isolated `CLAUDE_CONFIG_DIR` succeeds; `claude plugin details occam` lists the expected skills and agents with always-on cost within budget; `claude plugin validate` lists the expected mod hooks and calls (`details` does not count mod hooks); a session's debug log shows the mod `loaded`, and the knowledge tools are registered;
- installing into an isolated `OMP_PROFILE` succeeds; `omp --mode rpc --no-ui --no-session` reports the extension's `occam-*` commands through `get_available_commands`, with no `extension_error` frames;
- Claude Code does not execute the omp extension, omp does not execute `hooks/hooks.json` or `hooks/register.js`, and no files exist under `hooks/pre/`, `hooks/post/`, or `tools/`;
- the main plugin reaches its full adapter tier on both hosts on a machine with no `node` or `bun` on `PATH`; `occam-compat` reports degraded mode there instead of failing silently;
- a `session.start`/`SessionStart`/`session_start` smoke run observes the expected adapter tier on each host.

`npm run conformance` implements these checks for the tiers built so far. It covers the layout, both validators, `claude plugin test` (mod tests), isolated installs on both hosts, and zero-cost round trips per tier: `/occam-status`, `/occam-openrouter` with the key from the environment and from saved credentials, `setup` with a rejected key, and `remove` tightening a 0644 file to 0600. Extend it as each tier gains features, and re-run it whenever either host version changes.

### 15.5 Integration tests
- the advisor configuration method is applied without overwriting user settings and is fully reversible;
- the current runtime, provider, and adapter tier are detected on both hosts;
- advisor configured, available, and consulted states remain distinct;
- dynamic routing works across supported stage, subagent, and headless-session boundaries;
- retrieval uses graph/vault references and verifies freshness, including after Bash-driven file changes;
- indexing is incremental after a small source change;
- secret-like values are excluded from the vault, ledger, logs, and injected context;
- hard-budget exhaustion leaves a safe checkpoint;
- injected context is byte-identical across turns for identical inputs (cache safety).

### 15.6 Benchmark suite

Use representative tasks across retrieval, small implementation, multi-file implementation, debugging, refactoring, and architectural decisions. Run a baseline and an Occam-managed condition with equivalent acceptance criteria **on each host**:
- **Claude Code:** `claude plugin eval` with `--ablation with-without` (adds the no-plugin baseline arm), `--runs` ≥ 3, `--max-cost-usd`, and `--model` pinned to full model IDs.
- **omp:** an `occam-run` harness over `omp -p --mode json`, comparing isolated profiles with and without the plugin installed, with pinned models.

Track:
- correctness and test pass rate;
- regression and security findings;
- input/output/cache tokens per model, where observable;
- advisor, worker, indexing, retry, and footprint overhead;
- monetary cost at a fixed pricing version, and latency;
- number of files opened and repeated tool outputs;
- stale-note incidents, fallback frequency, and route compliance.

Pin model IDs and host versions for the duration of a benchmark. Compare per task in pairs, and report medians with bootstrap confidence intervals.

### 15.7 Release gate

Do not claim token-optimization success until benchmark results on each supported host show net cost savings on the target workload, without a material degradation in correctness, safety, or required verification. Define the acceptable quality-regression margin before the benchmark, not after seeing results. A suggested initial gate: no statistically meaningful correctness regression, and a positive median net saving whose 95% confidence interval excludes zero. Tune thresholds to sample size and risk. A host that fails the gate ships in advisory-only mode or not at all.

## 16. Implementation phases

0. **Packaging skeleton and conformance CI.** Build the §5.2 layout (`occam` and `occam-compat`), the empty adapters, and the §15.4 tests on both hosts, including a run on a machine without `node` or `bun`. The layout itself is proven by §5.9.
1. **Capability discovery.** Per-host probes for version, adapter tier, provider, allowlists, advisor support, and usage fidelity, feeding the capability registry.
2. **Occam routing core.** Tiers, normalized schema, quantized deterministic policy, allowlists, route reasons, bounded retries, global limits.
3. **Token ledger and usage parsers.** Both hosts, with null-safe accounting. This comes before any optimization, because savings cannot be claimed without measurement.
4. **Executor adapters.** Orchestrated mode (`occam-run`) first, as the authoritative path. Then interactive subagent routing (Claude Code `agent.spawn` or tier agents; omp `before_subagent_spawn`), then cache-checked in-session switching.
5. **Advisor integration.** Both backends, with the configuration policy of §7.2 and the separate states of §7.3.
6. **Knowledge service.** Deterministic incremental file-store index (§8.2), vault, freshness, retention gate, three in-process tools (MCP only in `occam-compat`).
7. **Context compression.** Insertion-time transforms per host, with cache-safety and marginal-savings measurement.
8. **Budgets and verification loop.** Budget thresholds, enforcement per mode, verification reserve, failure-based rerouting, final verification.
9. **Benchmark and hardening.** Both hosts: cost/correctness trade-offs, footprint, privacy, permissions, failure injection, documentation.

## 17. Definition of done

The implementation is complete only when:
- the plugin installs from one marketplace into both Claude Code and omp, and each host loads only its own runtime surfaces (§15.4 green on pinned versions);
- routing decisions are deterministic for the same normalized inputs, policy version, and registry, on both hosts;
- dynamic rerouting occurs at supported execution boundaries;
- unsupported model switching is detected and never falsely reported as successful;
- per-host capabilities are recorded with evidence, and degraded modes (including advisory-only) are reported;
- the advisor is configured through the §7.2 policy where supported, and configuration, availability, and confirmed consultation are separately represented;
- fallback behavior is visible and tested;
- usage values distinguish actual, estimated, partial, and unavailable, and records are disjoint across host, model, role, and purpose;
- token/cost reports include indexing, retries, workers, advisor usage where observable, verification, and plugin footprint;
- the always-on footprint is within budget on both hosts;
- the knowledge graph and vault are incremental, provenance-aware, and freshness-checked;
- source code remains authoritative;
- safety, permissions, secret redaction, and workspace boundaries are preserved;
- benchmark results establish net savings without unacceptable correctness loss on each supported host.

## 18. External references and implementation caveats

Use current official documentation, and verify behavior against the installed versions before release.

Claude Code:
- Advisor: https://code.claude.com/docs/en/advisor
- Model configuration: https://code.claude.com/docs/en/model-config
- Subagents: https://code.claude.com/docs/en/sub-agents
- Settings reference: https://code.claude.com/docs/en/settings
- Hooks reference: https://code.claude.com/docs/en/hooks
- Plugin manifest reference: https://code.claude.com/docs/en/plugins/manifest-reference
- Plugin components: https://code.claude.com/docs/en/plugins/components
- Mods: https://code.claude.com/docs/en/plugins/mods and https://code.claude.com/docs/en/plugins/mods/reference
- Headless mode: https://code.claude.com/docs/en/headless
- Cost tracking: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- Monitoring (OTel): https://code.claude.com/docs/en/monitoring-usage
- Anthropic advisor tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool

omp (bundled docs, readable inside omp as `omp://<file>`; source at https://github.com/can1357/oh-my-pi):
- `marketplace.md`, `plugin-manager-installer-plumbing.md`, `skills/authoring-marketplaces.md`: packaging, Claude-format compatibility
- `extensions.md`, `extension-loading.md`, `hooks.md`: extension API and event contracts
- `task-agent-discovery.md`, `tools/task.md`: subagent discovery, model precedence, results
- `models.md`, `settings.md`: model selectors, roles, pricing, settings layers
- `advisor-watchdog.md`: advisor runtime
- `session.md`, `compaction.md`, `memory.md`: session format, usage entries, compaction, memory backends
- `rpc.md`, `cli-reference.md`, `mcp-config.md`: headless control and MCP configuration

Host advisors depend on provider, version, and model pairing. Model aliases and roles can resolve to different underlying models over time. Model switching, subagent model selection, and usage visibility vary by host and adapter tier. These are explicit compatibility checks, not assumptions. This specification defines intended behavior; it cannot guarantee that every installed environment exposes every capability.

## Appendix A. Revision 2.0.0 review findings

Gaps found in version 1.0.0, and where they are resolved:

| # | Gap in 1.0.0 | Resolution |
|---|---|---|
| 1 | Claude Code only; no omp support | §5 (packaging, component and event mapping, capability matrix), plus host fields throughout |
| 2 | No deployment model: the spec did not say what runs where, or that a plugin cannot own the host's main loop | §3.2 deployment units, §3.3 interactive vs. orchestrated modes, route-compliance metric |
| 3 | Referenced types were undefined (`TokenBudget`, `ContextPackage`, `VerificationPlan`, `VerificationResult`, route decision) | §4.5 |
| 4 | Determinism undermined by raw float features and an implicit classifier | §4.3 quantization, pure-function signature, heuristic-first classifier with attributed cost |
| 5 | Policy hard-coded Anthropic aliases (`haiku/sonnet/opus`), which do not exist in omp | §4.4 tiers with per-host selectors |
| 6 | No limit across stages; only per-stage retries, so loops were possible | §4.6 |
| 7 | Prompt caching ignored; routing and compression could raise cost | §2 principle 11, §9.3, §9.5 |
| 8 | Compression had no mechanism; in-history rewriting would bust the cache | §9.2 per-host mechanisms, insertion-time only |
| 9 | Usage categories overlapped, so totals double counted | §10.1 disjoint dimensions, §10.2 record with `recordId` |
| 10 | Host usage pitfalls unhandled (shared message IDs, placeholder output tokens, final-request-only subagent usage, omp zero-cost unknown pricing) | §10.3, §15.2 |
| 11 | Net-savings formula ambiguous (indexing possibly subtracted twice; tokens summed across models) | §10.7 |
| 12 | The plugin's own context footprint was unbudgeted | §2 principle 12, §10.6, `footprint.*` config |
| 13 | Advisor section Claude-only; the persistent-setting instruction conflicted with least privilege; plugins cannot set `advisorModel` | §7.1 two backends, §7.2 configuration policy with reversible opt-in |
| 14 | Silent advisor pairing refusal and the feature-flag dependency were not modeled | §7.1, §7.5 |
| 15 | Vault in the repo by default: it gets indexed, committed, and grepped; no project ID, worktree, or concurrency model | §8.2, §8.3, §5.7 |
| 16 | `graph.json` as system of record is not incremental | §8.2 SQLite |
| 17 | Freshness missed changes made by Bash or external processes | §8.4 (`FileChanged` on Claude Code, dirty marking on omp) |
| 18 | Vault notes were a persistent prompt-injection vector | §8.5 |
| 19 | Overlap with host compaction, memory, and native routing (`opusplan`, prewalk) unaddressed | §5.6 |
| 20 | Different trust models (omp has no directory-trust prompt; `claude -p` skips the trust dialog) | §12 |
| 21 | "Validate against official documentation at startup" is not implementable at runtime | §6.1 probe-based capability registry, §7.5 |
| 22 | Benchmark lacked repeated runs, pinned models, a per-host baseline harness, and confidence intervals | §15.6, §15.7 |
| 23 | Phase order put measurement after the optimizations it was meant to measure | §16: ledger in phase 3, packaging/conformance in phase 0 |
| 24 | High-risk fallback order `[opus, sonnet]` allowed a silent downgrade | `tiers.fallbackOrder.highRisk: [deep]`, `allowHighRiskDowngrade`, §11 |
| 25 | Command hooks and the MCP server implicitly required a JavaScript runtime; the reference workstation has neither `node` nor `bun` on `PATH` | §3.2, §5.2, §5.7: in-process mod and extension in the main plugin; subprocess parts moved to optional `occam-compat`; file-based index store (§8.2) usable from every runtime |
| 26 | (Found during verification) The Claude Code mod runtime imposes a static `$` call-site rule and a 4 MiB per-file `$.fs` limit, and mods are gated by a rollout flag | §5.2 packaging rules, §5.9 mod probe, §6.1 probe-based capability detection |
| 27 | (Found during verification) `omp --plugin-dir` does not load `package.json` `omp.extensions`, and mod `$.fs` lacks rename/delete with non-atomic writes | §5.2 install (`omp -e` for development), §5.9, §8.2 self-validating files |
| 28 | (Decision, 2026-10-12) Occam's own model calls use OpenRouter; the hosts stay on the user's Claude subscription | §6.4, §10.3, §12, `sideCalls` config |
| 29 | (Request, 2026-10-12) One command to set the OpenRouter key on both hosts | §6.4 one-command setup, §12, `sideCalls.credentialsFile` |
| 30 | (Request, 2026-10-13) Workflow skills, plus philosopher-style thinking applied by stage | §4.7 |
| 31 | (Request, 2026-10-13) A descriptive plugin name, and no "jev" in skills or commands | Renamed everywhere to Occam (Occam's razor: use nothing that is not needed). Plugin `occam@occam-plugins`; commands `/occam-*`; skills unprefixed (`/occam:<skill>` in Claude Code); `OCCAM_*` variables; `~/.config/occam`, `~/.local/state/occam`. §5.9 keeps the throwaway probe names it recorded. |
