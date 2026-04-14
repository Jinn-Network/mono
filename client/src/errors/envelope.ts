/**
 * Error envelope for the Jinn client CLI surface.
 *
 * Contract: spec/2026-04-14-client-surface.md §5 (exit codes) and §6 (envelope).
 * Every non-zero exit from a jinn verb writes one of these objects to stdout
 * (not stderr — stderr is reserved for logs) and then exits with `exitCode`.
 */

export type ErrorCode =
  | 'funding_required'
  | 'invalid_invocation'
  | 'bootstrap_incomplete'
  | 'reconcile_needed'
  | 'transient_error'
  | 'fatal';

export const EXIT_CODES: Record<ErrorCode, number> = {
  funding_required: 10,
  invalid_invocation: 11,
  bootstrap_incomplete: 20,
  reconcile_needed: 30,
  transient_error: 40,
  fatal: 50,
};

export interface ErrorEnvelope {
  schemaVersion: 1;
  generatedAt: string;
  code: ErrorCode;
  exitCode: number;
  message: string;
  hint?: string;
  exampleCli?: string;
  details?: Record<string, unknown>;
}

export interface BuildEnvelopeInput {
  code: ErrorCode;
  message: string;
  hint?: string;
  exampleCli?: string;
  details?: Record<string, unknown>;
}

export function buildEnvelope(input: BuildEnvelopeInput): ErrorEnvelope {
  const env: ErrorEnvelope = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    code: input.code,
    exitCode: EXIT_CODES[input.code],
    message: input.message,
  };
  if (input.hint !== undefined) env.hint = input.hint;
  if (input.exampleCli !== undefined) env.exampleCli = input.exampleCli;
  if (input.details !== undefined) env.details = input.details;
  return env;
}
