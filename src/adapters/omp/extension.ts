// omp extension entry point, bundled to plugins/occam/dist/omp-extension.js and loaded through
// plugins/occam/package.json `omp.extensions`. Runs in-process in omp's Bun runtime.
// omp's own model traffic stays on the user's configured provider; Occam's side calls use
// OCCAM_OPENROUTER_API_KEY or the saved credentials, neither of which omp reads.
import { removeOpenRouterKey, resolveOpenRouterKey, saveOpenRouterKey } from "../../core/credentials.ts";
import { resolveConfigDir, resolveStateDir } from "../../core/dirs.ts";
import { checkOpenRouter, DEFAULT_SIDE_CALL_MODEL, type Http, KEY_ENV } from "../../core/openrouter.ts";
import { formatStatus } from "../../core/status.ts";
import { fileCredentialStore } from "./credential-store.ts";
import type { ExtensionAPI } from "./omp-api.ts";

declare const OCCAM_VERSION: string;

const http: Http = async (request) => {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  return { status: response.status, text: await response.text() };
};

export default function occam(pi: ExtensionAPI): void {
  const configDir = resolveConfigDir((name) => process.env[name]);
  const store = configDir === null ? null : fileCredentialStore(configDir);

  // Without a UI (print mode, `--mode rpc --no-ui`) omp makes notify a no-op.
  pi.registerCommand("occam-status", {
    description: "Show Occam plugin status for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        formatStatus({
          pluginVersion: OCCAM_VERSION,
          host: "omp",
          hostVersion: null,
          adapterTier: "extension",
          sessionId: ctx.sessionManager.getSessionId() ?? null,
          cwd: ctx.cwd,
          stateDir: resolveStateDir((name) => process.env[name]),
          openRouterKeySource: resolveOpenRouterKey(process.env[KEY_ENV], store === null ? null : await store.read())?.source ?? null,
        }),
        "info",
      );
    },
  });

  pi.registerCommand("occam-openrouter", {
    description: "Occam's OpenRouter key: setup, remove, or check (add `live` for one paid test call)",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "setup" || action === "remove") {
        if (store === null) {
          ctx.ui.notify("Occam has no config directory: set OCCAM_CONFIG_DIR, XDG_CONFIG_HOME, or HOME.", "error");
          return;
        }
        if (action === "remove") {
          ctx.ui.notify(await removeOpenRouterKey(store), "info");
          return;
        }
        // A dialog answer is not a prompt, so the key stays out of the transcript and prompt history.
        // omp masks only provider-login prompts, so the key is visible while typed.
        const candidate = await ctx.ui.input(
          "Occam: OpenRouter API key (checked with OpenRouter, then saved owner-only for Claude Code and omp)",
          "sk-or-…",
        );
        if (candidate === undefined) {
          ctx.ui.notify("Setup cancelled; nothing saved.", "info");
          return;
        }
        const result = await saveOpenRouterKey({
          http,
          store,
          candidate,
          envKeySet: Boolean(process.env[KEY_ENV]),
          now: () => new Date().toISOString(),
        });
        ctx.ui.notify(result.message, result.saved ? "info" : "warning");
        return;
      }
      if (action !== "" && action !== "live") {
        ctx.ui.notify("Usage: /occam-openrouter [setup | remove | live]", "warning");
        return;
      }
      const { report } = await checkOpenRouter({
        http,
        key: resolveOpenRouterKey(process.env[KEY_ENV], store === null ? null : await store.read()),
        model: DEFAULT_SIDE_CALL_MODEL,
        live: action === "live",
        host: "omp",
        now: () => new Date().toISOString(),
      });
      ctx.ui.notify(report, "info");
    },
  });
}
