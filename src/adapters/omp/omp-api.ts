// The subset of the omp extension API that Occam uses, as documented in omp://extensions.md (omp 18.10.1).

export interface ExtensionContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    /** Text dialog (omp://skills/authoring-hooks.md). Resolves to undefined when cancelled. Not masked. */
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
  sessionManager: { getSessionId(): string | undefined };
}

export interface ExtensionAPI {
  registerCommand(
    name: string,
    spec: { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> | void },
  ): void;
}
