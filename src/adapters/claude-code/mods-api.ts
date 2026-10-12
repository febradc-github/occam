// The subset of the Claude Code mods API that Occam uses, as documented in
// https://code.claude.com/docs/en/plugins/mods/reference and observed on Claude Code 2.1.295.
// Claude Code generates full declarations into `.claude-plugin/types/` when a mod is loaded
// interactively with --plugin-dir; replace this file with those if the surface grows.

type MaybePromise<T> = T | Promise<T>;

/** An element tree node returned by the constructors from `$.ui.resolve`. */
export type Element = object;

export interface Elements {
  Box(props: { flexDirection?: "row" | "column"; children: Element[] }): Element;
  Text(props: { children: string[] }): Element;
  Input(props: {
    key: string;
    label: string;
    placeholder?: string;
    value: string;
    submitLabel?: string;
    onSubmit(value: string): void | Promise<void>;
  }): Element;
}

export interface PaneRenderEvent {
  component: "Pane";
  requestId: string;
}

export interface ModsApi {
  command: {
    register(spec: { name: string; description: string; argumentHint?: string; immediate?: boolean }): Promise<void>;
  };
  env: { get(name: string): MaybePromise<string | undefined> };
  fs: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
  };
  http: {
    fetch(
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ): Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>;
  };
  process: { run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> };
  session: {
    id(): MaybePromise<string>;
    cwd(): MaybePromise<string>;
    version(): MaybePromise<{ version: string; base: string; builtAt: string }>;
  };
  ui: {
    open(spec: { id: string; title: string; focus?: boolean; closeOnEscape?: boolean }): Promise<unknown>;
    invalidate(event: "ui.render"): void;
    resolve(e: PaneRenderEvent): Elements;
  };
}

export interface SessionStartEvent {
  cwd: string;
  surface: string;
  isInteractive: boolean;
}

export interface CommandRunEvent {
  args: string;
}

export interface On {
  (event: "session.start", hook: ($: ModsApi, e: SessionStartEvent, next: (e: SessionStartEvent) => Promise<unknown>) => Promise<unknown>): void;
  (
    event: "command.run",
    matcher: { command: string },
    hook: ($: ModsApi, e: CommandRunEvent) => Promise<{ text?: string }>,
  ): void;
  (
    event: "ui.render",
    matcher: { component: "Pane" },
    hook: ($: ModsApi, e: PaneRenderEvent, next: (e: PaneRenderEvent) => Promise<Element>) => Promise<Element>,
  ): void;
}
