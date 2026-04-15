/**
 * CLI output helpers.
 *
 * Operational verbs emit JSON unless `--human` is set (TTY does not change
 * the default). `stdoutIsTty` is kept for callers/tests; `isJsonMode` only
 * keys off `human`.
 *
 * Spec note: `spec/2026-04-14-client-surface.md` §7.2 still describes a
 * TTY-based default; implementation and packaged README follow this module.
 * - NO_COLOR strips ANSI in human mode.
 */

export interface JsonModeInput {
  json: boolean;
  human: boolean;
  stdoutIsTty: boolean;
}

export function isJsonMode(input: JsonModeInput): boolean {
  return !input.human;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export interface HumanModeOpts {
  noColor: boolean;
}

export function formatHuman(text: string, opts: HumanModeOpts): string {
  if (opts.noColor) return text.replace(ANSI_PATTERN, '');
  return text;
}

/**
 * Decide the effective output mode for a verb and write the value.
 * Production callers pass `process.stdout`; tests inject a writer.
 */
export interface EmitOpts {
  json: boolean;
  human?: boolean;
  writer?: { write: (s: string) => boolean };
  stdoutIsTty?: boolean;
  noColor?: boolean;
}

export function emitResult(value: unknown, humanRender: (v: unknown) => string, opts: EmitOpts): void {
  const writer = opts.writer ?? process.stdout;
  const stdoutIsTty = opts.stdoutIsTty ?? Boolean(process.stdout.isTTY);
  const noColor = opts.noColor ?? Boolean(process.env['NO_COLOR']);
  if (isJsonMode({ json: opts.json, human: Boolean(opts.human), stdoutIsTty })) {
    writer.write(formatJson(value));
  } else {
    writer.write(formatHuman(humanRender(value), { noColor }) + '\n');
  }
}
