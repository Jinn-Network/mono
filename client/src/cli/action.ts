/**
 * Shared helpers for action verbs (verbs that emit transactions).
 *
 * Contract: spec/2026-04-14-client-surface.md §7.3 (dry-run / yes).
 */

import type { CommandContext } from './command.js';
import { buildEnvelope, EXIT_CODES } from '../errors/envelope.js';
import { emitResult } from './output.js';

export interface ConfirmFlags {
  yes: boolean;
  dryRun: boolean;
}

/**
 * Ensure an action is confirmed before proceeding.
 *
 * - Dry run → always permitted, returns true without any check.
 * - `--yes` → permitted regardless of TTY state.
 * - Non-TTY without `--yes` → emits invalid_invocation (exit 11) and returns false.
 * - TTY without `--yes` → v1 never prompts; emits invalid_invocation and returns false.
 */
export function ensureConfirmed(ctx: CommandContext, flags: ConfirmFlags): boolean {
  if (flags.dryRun) return true;
  if (flags.yes) return true;
  const envelope = buildEnvelope({
    code: 'invalid_invocation',
    message: 'This action requires explicit confirmation.',
    hint: 'Re-run with --yes to confirm, or --dry-run to see what would happen without executing.',
    exampleCli: 'jinn <verb> --dry-run',
    details: { field: 'confirmation', expected: '--yes or --dry-run' },
  });
  ctx.writer.write(JSON.stringify(envelope) + '\n');
  ctx.exit(EXIT_CODES.invalid_invocation);
  return false;
}

export interface DryRunPayload {
  verb: string;
  description: string;
  plan: unknown[];
}

/** Emit a dry-run JSON response (success path; no process exit). */
export function emitDryRun(ctx: CommandContext, payload: DryRunPayload): void {
  const body = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      dryRun: true,
      ...payload,
    };
  emitResult(
    body,
    (v) => {
      const value = v as DryRunPayload & { dryRun: true };
      return [
        `Dry run: ${value.verb}`,
        value.description,
        `Planned steps: ${value.plan.length}`,
        JSON.stringify(value.plan, null, 2),
      ].join('\n');
    },
    {
      json: ctx.argv.includes('--json'),
      human: ctx.argv.includes('--human'),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}
