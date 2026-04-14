/**
 * CLI output helpers.
 *
 * Contract: spec/2026-04-14-client-surface.md §7.2.
 * - JSON is implicit when stdout is not a TTY.
 * - NO_COLOR strips ANSI in human mode.
 */

export interface JsonModeInput {
  json: boolean;
  stdoutIsTty: boolean;
}

export function isJsonMode(input: JsonModeInput): boolean {
  return input.json || !input.stdoutIsTty;
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
  writer?: { write: (s: string) => boolean };
  stdoutIsTty?: boolean;
  noColor?: boolean;
}

export function emitResult(value: unknown, humanRender: (v: unknown) => string, opts: EmitOpts): void {
  const writer = opts.writer ?? process.stdout;
  const stdoutIsTty = opts.stdoutIsTty ?? Boolean(process.stdout.isTTY);
  const noColor = opts.noColor ?? Boolean(process.env['NO_COLOR']);
  if (isJsonMode({ json: opts.json, stdoutIsTty })) {
    writer.write(formatJson(value));
  } else {
    writer.write(formatHuman(humanRender(value), { noColor }) + '\n');
  }
}
