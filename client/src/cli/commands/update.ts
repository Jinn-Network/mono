import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import pluginCommand from './plugin-install.js';

class StringWriter {
  private chunks: string[] = [];
  write(s: string): boolean { this.chunks.push(s); return true; }
  toString(): string { return this.chunks.join(''); }
}

interface PluginInstallResultEntry {
  target: string;
  mcp: { status: string; detail: string };
  skill: { status: string; detail: string };
}

function summarizePluginInstall(
  output: string,
  exitCode: number | null,
): { status: 'ok' | 'error'; detail: string } {
  if (exitCode !== null && exitCode !== 0) {
    return { status: 'error', detail: output || `plugin install exited with code ${exitCode}` };
  }

  try {
    const parsed = JSON.parse(output) as { results?: PluginInstallResultEntry[] };
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
    return { status: 'ok', detail: 'Plugins updated' };
  } catch {
    return { status: 'error', detail: output || 'Unexpected plugin install output' };
  }
}

export interface UpdateDeps {
  pluginRun: typeof pluginCommand.run;
}

const PRODUCTION_DEPS: UpdateDeps = {
  pluginRun: pluginCommand.run.bind(pluginCommand),
};

export function createUpdateCommand(deps: UpdateDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'update',
    summary: 'Update the client package and refresh plugins in all configured AI tools',
    helpText: `Usage: jinn update [--human] [--skip-npm] [--skip-plugins]

Two steps:
  1. npm update -g @jinn-network/client  (updates binary + MCP server + skill source)
  2. jinn plugin install                  (refreshes skills in all configured tools)

The MCP server updates automatically (it's a binary on PATH).
Skills need re-installation because they are copied into each tool's
config directory.

Flags:
  --skip-npm        Skip the npm update step
  --skip-plugins    Skip the plugin re-install step

Examples:
  jinn update
  jinn update --human
  jinn update --skip-npm          # just refresh plugins with current version
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
          // Continue — plugin install may still be useful even if npm update failed
        }
      } else {
        steps.push({ step: 'npm-update', status: 'skipped', detail: '--skip-npm' });
      }

      // ── Step 2: Re-install plugins (propagates skill updates) ──
      if (!skipPlugins) {
        console.error('[update] Updating plugins...');
        const pluginWriter = new StringWriter();
        let pluginExitCode: number | null = null;
        await deps.pluginRun({
          argv: ['install', '--json'],
          stdoutIsTty: false,
          writer: pluginWriter,
          exit: (code) => { pluginExitCode = code; },
          env: ctx.env,
        });

        const pluginOutput = pluginWriter.toString().trim();
        const pluginResult = summarizePluginInstall(pluginOutput, pluginExitCode);
        if (pluginResult.status === 'ok') {
          steps.push({ step: 'plugin-install', status: 'ok', detail: pluginResult.detail });
          console.error('[update] Plugins updated.');
        } else {
          steps.push({ step: 'plugin-install', status: 'error', detail: pluginResult.detail });
          console.error('[update] Plugin update had issues.');
        }
      } else {
        steps.push({ step: 'plugin-install', status: 'skipped', detail: '--skip-plugins' });
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
