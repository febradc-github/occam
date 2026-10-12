// Claude Code mod entry point, bundled to plugins/occam/hooks/register.js.
// Claude Code statically checks this file: `$` may appear only as `$.namespace.method(...)`
// call sites, so core code receives plain values and closures, never `$` (spec §5.2).
// `$.env.get` names must be string literals for the same check.
import { removeOpenRouterKey, resolveOpenRouterKey, saveOpenRouterKey } from "../../core/credentials.ts";
import { resolveConfigDir, resolveStateDir } from "../../core/dirs.ts";
import { checkOpenRouter, DEFAULT_SIDE_CALL_MODEL, type Http } from "../../core/openrouter.ts";
import { formatStatus } from "../../core/status.ts";
import { type ModFilePorts, modCredentialStore } from "./credential-store.ts";
import type { On } from "./mods-api.ts";

declare const OCCAM_VERSION: string;

const SETUP_PANE = "occam-openrouter-setup";
const NO_CONFIG_DIR = "Occam has no config directory: set OCCAM_CONFIG_DIR, XDG_CONFIG_HOME, or HOME.";

// Set once in session.start. The process environment does not change mid-session, and the
// closures below call `$` at their own call sites, which the mod checker accepts.
let env: Record<string, string | undefined> = {};
let interactive = false;
let ports: ModFilePorts | null = null;
let http: Http = async () => ({ status: 0, text: "" });
let setupNote = "";

function credentialStore() {
  const dir = resolveConfigDir((name) => env[name]);
  return dir === null || ports === null ? null : modCredentialStore(dir, ports);
}

export function register(on: On): void {
  on("session.start", async ($, e, next) => {
    interactive = e.isInteractive;
    env = {
      HOME: await $.env.get("HOME"),
      OCCAM_CONFIG_DIR: await $.env.get("OCCAM_CONFIG_DIR"),
      OCCAM_OPENROUTER_API_KEY: await $.env.get("OCCAM_OPENROUTER_API_KEY"),
      OCCAM_STATE_DIR: await $.env.get("OCCAM_STATE_DIR"),
      XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
      XDG_STATE_HOME: await $.env.get("XDG_STATE_HOME"),
    };
    ports = {
      exists: (path) => $.fs.exists(path),
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      run: (argv) => $.process.run(argv),
    };
    http = async (request) => {
      const response = await $.http.fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
      return { status: response.status, text: response.text };
    };
    await $.command.register({ name: "occam-status", description: "Show Occam plugin status for this session", immediate: true });
    await $.command.register({
      name: "occam-openrouter",
      description: "Occam's OpenRouter key: setup, remove, or check (add `live` for one paid test call)",
      argumentHint: "[setup | remove | live]",
      immediate: true,
    });
    return next(e);
  });

  on("command.run", { command: "occam-status" }, async ($) => {
    const store = credentialStore();
    const hostVersion = await $.session.version();
    const key = resolveOpenRouterKey(env.OCCAM_OPENROUTER_API_KEY, store === null ? null : await store.read());
    const text = formatStatus({
      pluginVersion: OCCAM_VERSION,
      host: "claude-code",
      hostVersion: hostVersion.version,
      adapterTier: "mod",
      sessionId: await $.session.id(),
      cwd: await $.session.cwd(),
      stateDir: resolveStateDir((name) => env[name]),
      openRouterKeySource: key?.source ?? null,
    });
    return { text };
  });

  on("command.run", { command: "occam-openrouter" }, async ($, e) => {
    const action = e.args.trim();
    const store = credentialStore();
    if (action === "setup") {
      if (!interactive) {
        return {
          text: "Setup opens a pane to type the key, so run /occam-openrouter setup in an interactive Claude Code session, or set OCCAM_OPENROUTER_API_KEY.",
        };
      }
      if (store === null) return { text: NO_CONFIG_DIR };
      setupNote = "";
      // The pane's field is not a prompt, so the key stays out of the transcript and prompt history.
      await $.ui.open({ id: SETUP_PANE, title: "Occam: OpenRouter API key", focus: true, closeOnEscape: true });
      return {};
    }
    if (action === "remove") return { text: store === null ? NO_CONFIG_DIR : await removeOpenRouterKey(store) };
    if (action !== "" && action !== "live") return { text: "Usage: /occam-openrouter [setup | remove | live]" };
    const { report } = await checkOpenRouter({
      http,
      key: resolveOpenRouterKey(env.OCCAM_OPENROUTER_API_KEY, store === null ? null : await store.read()),
      model: DEFAULT_SIDE_CALL_MODEL,
      live: action === "live",
      host: "claude-code",
      now: () => new Date().toISOString(),
    });
    return { text: report };
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== SETUP_PANE) return next(e);
    const { Box, Text, Input } = $.ui.resolve(e);
    return Box({
      flexDirection: "column",
      children: [
        Text({
          children: [
            "Paste the OpenRouter API key for Occam's own model calls. Occam checks it with OpenRouter, then saves it " +
              "owner-only in its config directory, where omp reads it too. The field is not masked. Esc closes.",
          ],
        }),
        Input({
          key: "openrouter-key",
          label: "Key",
          placeholder: "sk-or-…",
          value: "",
          submitLabel: "save",
          onSubmit: async (value) => {
            const store = credentialStore();
            if (store === null) {
              setupNote = NO_CONFIG_DIR;
            } else {
              setupNote = "Checking the key with OpenRouter…";
              $.ui.invalidate("ui.render");
              const result = await saveOpenRouterKey({
                http,
                store,
                candidate: value,
                envKeySet: Boolean(env.OCCAM_OPENROUTER_API_KEY),
                now: () => new Date().toISOString(),
              });
              setupNote = result.message;
            }
            $.ui.invalidate("ui.render");
          },
        }),
        ...(setupNote === "" ? [] : [Text({ children: [setupNote] })]),
      ],
    });
  });
}
