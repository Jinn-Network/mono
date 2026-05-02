import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import integrationsCommand from './integrations.js';

class StringWriter {
  private chunks: string[] = [];
  write(s: string): boolean { this.chunks.push(s); return true; }
  toString(): string { return this.chunks.join(''); }
}

interface IntegrationInstallResultEntry {
  target: string;
  mcp: { status: string; detail: string };
  skill: { status: string; detail: string };
}

function summarizeIntegrationInstall(
  output: string,
  exitCode: number | null,
): { status: 'ok' | 'error'; detail: string } {
  if (exitCode !== null && exitCode !== 0) {
    return { status: 'error', detail: output || `integrations install exited with code ${exitCode}` };
  }

  try {
    const parsed = JSON.parse(output) as { results?: IntegrationInstallResultEntry[] };
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const failures = results.flatMap((result) => {
      const failedParts: string[] = [];
      if (result.mcp.status === 'error') failedParts.push(`MCP: ${result.mcp.detail}`);
      if (result.skill.status === 'error') failedParts.push(`Skill: ${result.skill.detail}`);
      if (failedParts.length === 0) return [];
      return [`${result.target} (${failedParts.join('; ')})`];
    });
    if (failures.length > 0) {
      return { status: 'error', detail: failures.join(' | ') };
    }
    return { status: 'ok', detail: 'Integrations updated' };
  } catch {
    return { status: 'error', detail: output || 'Unexpected integrations install output' };
  }
}

export interface UpdateDeps {
  integrationsRun: typeof integrationsCommand.run;
}

const PRODUCTION_DEPS: UpdateDeps = {
  integrationsRun: integrationsCommand.run.bind(integrationsCommand),
};

export function createUpdateCommand(deps: UpdateDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'update',
    summary: 'Update the client package and refresh integrations in all configured AI tools',
    helpText: `Usage: jinn update [--human] [--skip-npm] [--skip-plugins]

Two steps:
  1. npm update -g @jinn-network/client  (updates binary + MCP server + skill source)
  2. jinn integrations install            (refreshes skills in all configured tools)

The MCP server updates automatically (it's a binary on PATH).
Skills need re-installation because they are copied into each tool's
config directory.

Flags:
  --skip-npm        Skip the npm update step
  --skip-plugins    Skip the integrations refresh step

Examples:
  jinn update
  jinn update --human
  jinn update --skip-npm          # just refresh integrations with current version
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: {
            ...COMMON_FLAGS,
            'skip-npm': { type: 'boolean', default: false },
            'skip-plugins': { type: 'boolean', default: false },
          },
          allowPositionals: false,
        });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn update',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const skipNpm = parsed.values['skip-npm'] as boolean;
      const skipPlugins = parsed.values['skip-plugins'] as boolean;

      const steps: Array<{ step: string; status: string; detail: string }> = [];

      // ── Step 1: Update the npm package ──
      if (!skipNpm) {
        console.error('[update] Updating @jinn-network/client...');
        try {
          const output = execSync('npm update -g @jinn-network/client 2>&1', {
            encoding: 'utf-8',
            timeout: 120_000,
          });
          steps.push({ step: 'npm-update', status: 'ok', detail: output.trim() || 'Package updated' });
          console.error('[update] Package updated.');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          steps.push({ step: 'npm-update', status: 'error', detail: message });
          console.error(`[update] npm update failed: ${message}`);
          // Continue — integrations refresh may still be useful even if npm update failed
        }
      } else {
        steps.push({ step: 'npm-update', status: 'skipped', detail: '--skip-npm' });
      }

      // ── Step 2: Re-install integrations (propagates skill updates) ──
      if (!skipPlugins) {
        console.error('[update] Updating integrations...');
        const integrationWriter = new StringWriter();
        let integrationExitCode: number | null = null;
        await deps.integrationsRun({
          argv: ['install', '--json'],
          stdoutIsTty: false,
          writer: integrationWriter,
          exit: (code: number) => { integrationExitCode = code; },
          env: ctx.env,
        });

        const integrationOutput = integrationWriter.toString().trim();
        const integrationResult = summarizeIntegrationInstall(integrationOutput, integrationExitCode);
        if (integrationResult.status === 'ok') {
          steps.push({ step: 'integrations-install', status: 'ok', detail: integrationResult.detail });
          console.error('[update] Integrations updated.');
        } else {
          steps.push({ step: 'integrations-install', status: 'error', detail: integrationResult.detail });
          console.error('[update] Integration update had issues.');
        }
      } else {
        steps.push({ step: 'integrations-install', status: 'skipped', detail: '--skip-plugins' });
      }

      const allOk = steps.every((s) => s.status === 'ok' || s.status === 'skipped');

      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'update',
          ok: allOk,
          steps,
        },
        (v) => {
          const value = v as { ok: boolean; steps: Array<{ step: string; status: string; detail: string }> };
          const lines = value.steps.map(
            (s) => `  ${s.step.padEnd(16)} ${s.status}${s.status === 'error' ? `: ${s.detail}` : ''}`,
          );
          return `Update ${value.ok ? 'complete' : 'completed with errors'}:\n${lines.join('\n')}`;
        },
        {
          json: Boolean(parsed.values.json),
          human: Boolean(parsed.values.human),
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
    },
  };
}

const command: CommandModule = createUpdateCommand();
export default command;
