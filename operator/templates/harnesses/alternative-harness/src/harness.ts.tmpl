// HarnessAdapter contract — the impl talks to the harness through this
// interface. The package owns this type; it does NOT depend on
// `claude-code-learner/types.ts` (which is internal to that package).
//
// Production builders implement this around their own runtime
// (Pi.dev, Codex CLI, Gemini CLI, custom subprocess, etc.).

export interface HarnessPromptArgs {
  promptId: string;
  systemPrompt: string;
  userPrompt: string;
  /** Per-phase budget in ms. Caller honours abort. */
  budgetMs: number;
  abort: AbortSignal;
}

export interface HarnessAdapter {
  readonly name: string;

  /**
   * Send a prompt to the harness's underlying agent runtime; receive a
   * structured JSON result. Used by every phase.
   */
  promptForJson<T>(args: HarnessPromptArgs): Promise<T>;

  /**
   * Optional: signal that a phase has finished, for harnesses that
   * persist conversation state across calls (e.g. Pi.dev's session model).
   */
  closePhase?(phaseId: string): Promise<void>;
}
