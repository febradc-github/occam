// Host conformance checks (spec §15.4). Installs the plugin into throwaway Claude Code and omp
// configurations and confirms each host loads only its own runtime surface.
//
// No model request can be billed: child processes get an allowlisted environment plus placeholder
// keys, and the isolated configs hold no stored credentials, so any request that does go out fails
// authentication. The OpenRouter key is deliberately invalid: OpenRouter rejects it with a free 401,
// which still exercises each host's real HTTP path.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { CREDENTIALS_FILE } from "../src/core/credentials.ts";
import { DEFAULT_SIDE_CALL_MODEL } from "../src/core/openrouter.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const plugin = join(repo, "plugins/occam");
const pluginId = `occam@${JSON.parse(readFileSync(join(repo, ".claude-plugin/marketplace.json"), "utf8")).name}`;

const INVALID_OPENROUTER_KEY = "sk-or-placeholder-invalid";
/** Workflow skills shipped in plugins/occam/skills. */
const SKILLS = ["brainstorm", "plan", "execute", "review"];
/** Spec §10.6: always-on footprint budget in tokens. */
const ALWAYS_ON_TOKEN_BUDGET = 1500;
/** A report that reached OpenRouter's public endpoints and had the invalid key, read from `source`, rejected. */
const openRouterReport = (source: string) =>
  new RegExp(`model: ${DEFAULT_SIDE_CALL_MODEL.replace(/[./]/g, "\\$&")} - [1-9]\\d* endpoints[\\s\\S]*key \\(from ${source}\\): rejected \\(401`);

/** Writes a world-readable credentials file holding the invalid key and an entry Occam does not own. */
function seedCredentials(dir: string): string {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const path = join(dir, CREDENTIALS_FILE);
  writeFileSync(path, JSON.stringify({ other: { keep: true }, openrouter: { apiKey: INVALID_OPENROUTER_KEY } }));
  chmodSync(path, 0o644);
  return path;
}

/** Checks what `remove` must leave behind: owner-only modes and only the entry Occam does not own. */
function removedOwnerOnly(path: string): { ok: boolean; detail: string } {
  const fileMode = statSync(path).mode & 0o777;
  const dirMode = statSync(join(path, "..")).mode & 0o777;
  const content = readFileSync(path, "utf8");
  const ok = fileMode === 0o600 && dirMode === 0o700 && JSON.stringify(JSON.parse(content)) === JSON.stringify({ other: { keep: true } });
  return { ok, detail: `file ${fileMode.toString(8)}, dir ${dirMode.toString(8)}, content ${content.trim()}` };
}

const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "XDG_RUNTIME_DIR"];

function isolatedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-placeholder-no-requests", ...extra };
  for (const name of ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail: detail.trim() });
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`,
  };
}

function checkLayout(): void {
  const executedByOmp = ["hooks/pre", "hooks/post", "tools"].filter((dir) => existsSync(join(plugin, dir)));
  record(
    "layout: nothing under hooks/pre, hooks/post, or tools (omp would execute it)",
    executedByOmp.length === 0,
    executedByOmp.length === 0 ? "clean" : `present: ${executedByOmp.join(", ")}`,
  );
}

function checkClaudeCode(): void {
  const validatePlugin = run("claude", ["plugin", "validate", "--strict", plugin]);
  record("claude: plugin validates with --strict", validatePlugin.status === 0, validatePlugin.output);
  const expectedHooks = "hooks: session.start, command.run{command=occam-status}, command.run{command=occam-openrouter}, ui.render{component=Pane}";
  record("claude: validator sees the mod hooks", validatePlugin.output.includes(expectedHooks), `expected \`${expectedHooks}\``);
  const modTests = run("claude", ["plugin", "test", plugin]);
  record("claude: mod tests pass (claude plugin test)", modTests.status === 0, modTests.output);
  const validateMarketplace = run("claude", ["plugin", "validate", "--strict", repo]);
  record("claude: marketplace validates with --strict", validateMarketplace.status === 0, validateMarketplace.output);

  const configDir = mkdtempSync(join(tmpdir(), "occam-conformance-claude-"));
  const cwd = mkdtempSync(join(tmpdir(), "occam-conformance-cwd-"));
  const occamConfig = mkdtempSync(join(tmpdir(), "occam-conformance-occamcfg-"));
  // An invalid key exercises the real HTTP path: OpenRouter rejects it with a free 401.
  const envKey = isolatedEnv({ CLAUDE_CONFIG_DIR: configDir, OCCAM_CONFIG_DIR: occamConfig, OCCAM_OPENROUTER_API_KEY: INVALID_OPENROUTER_KEY });
  const savedKey = isolatedEnv({ CLAUDE_CONFIG_DIR: configDir, OCCAM_CONFIG_DIR: occamConfig });
  try {
    const add = run("claude", ["plugin", "marketplace", "add", repo], { env: envKey });
    const install = run("claude", ["plugin", "install", pluginId], { env: envKey });
    record("claude: installs from the marketplace", add.status === 0 && install.status === 0, `${add.output}${install.output}`);
    const details = run("claude", ["plugin", "details", "occam"], { env: envKey });
    const alwaysOn = Number(/Always-on:\s+~(\d+) tok/.exec(details.output)?.[1] ?? Number.NaN);
    record(
      "claude: all workflow skills load, within the always-on token budget",
      SKILLS.every((skill) => details.output.includes(skill)) && alwaysOn <= ALWAYS_ON_TOKEN_BUDGET,
      `always-on ~${alwaysOn} tok (budget ${ALWAYS_ON_TOKEN_BUDGET})\n${details.output}`,
    );

    const printMode = (command: string, env: NodeJS.ProcessEnv) => {
      const output = run("claude", ["-p", command, "--output-format", "json"], { env, cwd });
      try {
        const result: { num_turns?: number; total_cost_usd?: number; result?: string } = JSON.parse(output.stdout);
        return { local: result.num_turns === 0 && result.total_cost_usd === 0, text: result.result ?? "" };
      } catch {
        return { local: false, text: output.output.slice(0, 500) };
      }
    };
    const status = printMode("/occam-status", envKey);
    record(
      "claude: /occam-status is answered by the mod tier without a model turn",
      status.local && /adapter tier: mod/.test(status.text),
      status.text,
    );
    const openRouter = printMode("/occam-openrouter", envKey);
    record(
      "claude: /occam-openrouter reaches OpenRouter through $.http.fetch without a model turn",
      openRouter.local && openRouterReport("OCCAM_OPENROUTER_API_KEY").test(openRouter.text),
      openRouter.text,
    );
    const setup = printMode("/occam-openrouter setup", envKey);
    record(
      "claude: setup in print mode points to an interactive session and saves nothing",
      setup.local && /interactive Claude Code session/.test(setup.text) && !existsSync(join(occamConfig, CREDENTIALS_FILE)),
      setup.text,
    );

    const credentials = seedCredentials(occamConfig);
    const saved = printMode("/occam-openrouter", savedKey);
    record(
      "claude: the check reads the saved key when the environment has none",
      saved.local && openRouterReport("saved credentials").test(saved.text),
      saved.text,
    );
    const remove = printMode("/occam-openrouter remove", savedKey);
    const after = removedOwnerOnly(credentials);
    record(
      "claude: remove drops only the key and leaves the file owner-only (real $.fs + chmod)",
      remove.local && /Removed the saved OpenRouter key/.test(remove.text) && after.ok,
      `${remove.text}\n${after.detail}`,
    );
  } finally {
    for (const dir of [configDir, cwd, occamConfig]) rmSync(dir, { recursive: true, force: true });
  }
}

interface Frame {
  type?: string;
  id?: string;
  method?: string;
  message?: string;
  agentInvoked?: boolean;
  data?: { commands?: Array<{ name: string; source: string }>; agentInvoked?: boolean };
}

interface OmpProbe {
  commands: Array<{ name: string; source: string }>;
  /** One `notify` message per prompt, in order; null when none arrived. */
  notifies: Array<string | null>;
  agentInvoked: boolean;
  extensionErrors: Frame[];
}

/**
 * Starts an omp RPC session, lists commands, sends each prompt, and reports what came back.
 * `input` dialogs are answered with `inputAnswers` in order, or cancelled when none are left.
 */
async function probeOmp(
  extraArgs: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  prompts: string[],
  inputAnswers: string[] = [],
): Promise<OmpProbe> {
  const child = spawn("omp", ["--mode", "rpc", "--no-session", "--cwd", cwd, ...extraArgs], { env, stdio: "pipe" });
  const frames: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame | null) => void }> = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    let frame: Frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    frames.push(frame);
    if (frame.type === "extension_ui_request" && frame.method === "input" && frame.id !== undefined) {
      const value = inputAnswers.shift();
      const response = value === undefined ? { cancelled: true } : { value };
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: frame.id, ...response })}\n`);
    }
    for (const waiter of [...waiters]) {
      if (waiter.match(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  const waitFor = (match: (frame: Frame) => boolean, timeoutMs: number) =>
    new Promise<Frame | null>((resolve) => {
      const seen = frames.find(match);
      if (seen) return resolve(seen);
      const waiter = { match, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          resolve(null);
        }
      }, timeoutMs);
    });

  try {
    if (!(await waitFor((f) => f.type === "ready", 30_000))) throw new Error("omp RPC never sent its ready frame");
    child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_available_commands" })}\n`);
    const commands = await waitFor((f) => f.type === "response" && f.id === "commands", 15_000);
    const notifies: Array<string | null> = [];
    let agentInvoked = false;
    const isNotify = (f: Frame) => f.type === "extension_ui_request" && f.method === "notify";
    for (const [index, message] of prompts.entries()) {
      const id = `prompt-${index}`;
      const notifiesBefore = frames.filter(isNotify).length;
      child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
      const ack = await waitFor((f) => f.type === "response" && f.id === id, 15_000);
      // The first notify after this prompt is its report.
      const notify = await waitFor((f) => isNotify(f) && frames.filter(isNotify).indexOf(f) >= notifiesBefore, 20_000);
      notifies.push(notify?.message ?? null);
      // A locally handled command acks without `data`; a model turn shows up as `agent_start`
      // and a later `prompt_result` with `agentInvoked: true`.
      const result = await waitFor((f) => f.type === "prompt_result" && f.id === id, 3_000);
      agentInvoked ||= ack?.data?.agentInvoked === true || result?.agentInvoked === true;
    }
    return {
      commands: commands?.data?.commands ?? [],
      notifies,
      agentInvoked: agentInvoked || frames.some((f) => f.type === "agent_start"),
      extensionErrors: frames.filter((f) => f.type === "extension_error"),
    };
  } finally {
    child.kill("SIGTERM");
  }
}

async function checkOmp(): Promise<void> {
  const profiles = [`occam-conformance-${process.pid}`, `occam-conformance-${process.pid}-dev`];
  const cwd = mkdtempSync(join(tmpdir(), "occam-conformance-cwd-"));
  const emptyConfig = mkdtempSync(join(tmpdir(), "occam-conformance-occamcfg-"));
  const seededConfig = mkdtempSync(join(tmpdir(), "occam-conformance-occamcfg-"));
  try {
    const env = isolatedEnv({ OMP_PROFILE: profiles[0], OCCAM_CONFIG_DIR: emptyConfig, OCCAM_OPENROUTER_API_KEY: INVALID_OPENROUTER_KEY });
    const add = run("omp", ["plugin", "marketplace", "add", repo], { env });
    const install = run("omp", ["plugin", "install", pluginId], { env });
    record("omp: installs from the marketplace", add.status === 0 && install.status === 0, `${add.output}${install.output}`);

    const installed = await probeOmp([], env, cwd, ["/occam-status", "/occam-openrouter", "/occam-openrouter setup"], [INVALID_OPENROUTER_KEY]);
    const [status, openRouter, setup] = installed.notifies;
    record(
      "omp: extension registers occam-status and occam-openrouter",
      ["occam-status", "occam-openrouter"].every((name) => installed.commands.some((c) => c.name === name && c.source === "extension")),
      JSON.stringify(installed.commands.filter((c) => c.name.includes("occam"))),
    );
    record(
      "omp: all workflow skills load as skill commands",
      SKILLS.every((skill) => installed.commands.some((c) => c.name === `skill:${skill}` && c.source === "skill")),
      JSON.stringify(installed.commands.filter((c) => c.name.startsWith("skill:occam"))),
    );
    record(
      "omp: /occam-status is answered by the extension tier",
      /adapter tier: extension/.test(status ?? ""),
      status ?? "no notify frame",
    );
    record(
      "omp: /occam-openrouter reaches OpenRouter through fetch",
      openRouterReport("OCCAM_OPENROUTER_API_KEY").test(openRouter ?? ""),
      openRouter ?? "no notify frame",
    );
    record(
      "omp: setup asks through an input dialog and saves nothing OpenRouter rejects",
      /OpenRouter rejected the key .*nothing saved/.test(setup ?? "") && !existsSync(join(emptyConfig, CREDENTIALS_FILE)),
      setup ?? "no notify frame",
    );
    record("omp: no prompt started a model turn", !installed.agentInvoked, "a prompt reached the model");
    record("omp: no extension errors", installed.extensionErrors.length === 0, JSON.stringify(installed.extensionErrors));

    // `--plugin-dir` does not load package.json `omp.extensions` on omp 18.10.1; `-e` is the dev path.
    const credentials = seedCredentials(seededConfig);
    const dev = await probeOmp(
      ["-e", join(plugin, "dist/omp-extension.js")],
      isolatedEnv({ OMP_PROFILE: profiles[1], OCCAM_CONFIG_DIR: seededConfig }),
      cwd,
      ["/occam-openrouter", "/occam-openrouter remove"],
    );
    const [saved, remove] = dev.notifies;
    record(
      "omp: -e loads the built extension (local development path)",
      dev.commands.some((c) => c.name === "occam-status" && c.source === "extension") && dev.extensionErrors.length === 0,
      JSON.stringify(dev.commands.filter((c) => c.name.includes("occam"))),
    );
    record(
      "omp: the check reads the saved key when the environment has none",
      openRouterReport("saved credentials").test(saved ?? ""),
      saved ?? "no notify frame",
    );
    const after = removedOwnerOnly(credentials);
    record(
      "omp: remove drops only the key and leaves the file owner-only",
      /Removed the saved OpenRouter key/.test(remove ?? "") && after.ok,
      `${remove ?? "no notify frame"}\n${after.detail}`,
    );
  } finally {
    for (const dir of [cwd, emptyConfig, seededConfig]) rmSync(dir, { recursive: true, force: true });
    for (const profile of profiles) rmSync(join(homedir(), ".omp/profiles", profile), { recursive: true, force: true });
  }
}

checkLayout();
checkClaudeCode();
await checkOmp();

for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
  if (!check.ok) console.log(`      ${check.detail.split("\n").join("\n      ")}`);
}
const failed = checks.filter((check) => !check.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
