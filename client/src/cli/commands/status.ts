import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { gatherIntrospectionRaw as defaultGatherIntrospectionRaw } from '../introspection-context.js';
import { assembleStatusRollupV1 as defaultAssembleStatusRollupV1 } from '../../api/status-rollup-build.js';
import type { StatusRollupV1Response, StatusDetailV1 } from '../../api/status-rollup-build.js';
import { loadConfig, getConfigPathFromArgs, buildConfigProvenance, type ConfigProvenance } from '../../config.js';
import type { JinnConfig } from '../../config.js';
import {
  resolveTaskNativeReadiness,
  type TaskNativeReadiness,
} from '../task-native-readiness.js';

export interface StatusDeps {
  gatherIntrospectionRaw: typeof defaultGatherIntrospectionRaw;
  assembleStatusRollupV1: typeof defaultAssembleStatusRollupV1;
  loadConfig?: typeof loadConfig;
  getConfigPathFromArgs?: typeof getConfigPathFromArgs;
  resolveTaskNativeReadiness?: (config: JinnConfig) => TaskNativeReadiness;
}

const PRODUCTION_DEPS: StatusDeps = {
  gatherIntrospectionRaw: defaultGatherIntrospectionRaw,
  assembleStatusRollupV1: defaultAssembleStatusRollupV1,
};

type StatusPayload = StatusRollupV1Response & {
  config?: ConfigProvenance;
  taskNative?: TaskNativeReadiness;
};

function humanDetail(d: StatusDetailV1): string {
  const lines: string[] = ['', '--- detail ---'];
  lines.push(`bootstrap: ${d.lastBootstrapStep ?? 'no fleet yet'}${d.fleetUpdatedAt ? ` (updated ${d.fleetUpdatedAt})` : ''}`);
  if (d.lastDaemonEvent) {
    const e = d.lastDaemonEvent;
    lines.push(`last event: ${e.ts ?? 'unknown time'} ${e.kind}${e.outcome ? ` outcome=${e.outcome}` : ''}${e.txHash ? ` tx=${e.txHash.slice(0, 10)}…` : ''}`);
  } else {
    lines.push('last event: none yet');
  }
  if (d.lastClaudeSession) {
    const s = d.lastClaudeSession;
    const dur = Math.round(s.durationMs / 1000);
    lines.push(`last claude session: req=${s.requestId.slice(0, 10)}… sess=${s.sessionId.slice(0, 8)}… dur=${dur}s${s.aborted ? ' ABORTED' : ''}`);
  } else {
    lines.push('last claude session: none yet');
  }
  lines.push(`last chain tx: ${d.lastChainTx ?? 'none yet'}`);
  if (d.latestSetupArchive) {
    lines.push(
      `previous setup archive: ${d.latestSetupArchive.backupStatePath} ` +
      `(services ${d.latestSetupArchive.serviceIndexes.join(', ') || '-'})`,
    );
  }
  lines.push('next actions:');
  for (const action of d.nextActions) {
    lines.push(`  • ${action}`);
  }
  return lines.join('\n');
}

function humanStatus(v: StatusPayload): string {
  const health = v.exit.blocking ? `degraded: ${v.exit.hint ?? 'attention needed'}` : 'healthy';
  const parts = [
    `daemon=${v.daemon.state} network=${v.daemon.network} chain=${v.rpc.chainId} block=${v.rpc.blockNumber}`,
    `health=${health}`,
    `fleet: ${v.fleet.size} services, ${v.fleet.complete} complete, ${v.fleet.needsAttention} need attention`,
    v.taskNative
      ? `task-native: solver=${v.taskNative.solverReady ? 'ready' : 'not-ready'} evaluator=${v.taskNative.evaluatorReady ? 'ready' : 'not-ready'} (${v.taskNative.detail})`
      : '',
    v.exit.blocking && v.exit.hint ? `hint: ${v.exit.hint}` : '',
  ].filter(Boolean);
  if (v.detail) {
    parts.push(humanDetail(v.detail));
  }
  return parts.join('\n');
}

export function createStatusCommand(deps: StatusDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'status',
    summary: 'Daemon liveness + roll-up (poll this for monitoring; pull detail separately)',
    helpText: `Usage: jinn status [--detail] [--human]

Emits the §4.1 roll-up: daemon state, RPC reachability, fleet size /
complete / needsAttention counts, pending earnings total, and a
top-level exit hint.

A monitoring loop needs only these fields:
  - rpc.ok
  - fleet.needsAttention
  - exit.blocking

All of (rpc.ok === true && fleet.needsAttention === 0 && exit.blocking === false)
means healthy. Pull \`jinn fleet\` or \`jinn history\` for detail.

--detail  Include diagnostic detail: last bootstrap step, last daemon event,
          last Claude session, last chain tx, and next operator actions.
          Addresses audit finding U4 — single "what's happening?" command.

Examples:
  jinn status
  jinn status --detail
  jinn status --detail --human
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseCommandArgs(ctx.argv, {
          ...COMMON_FLAGS,
          detail: { type: 'boolean' as const, default: false },
        });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn status',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      const configPath =
        (deps.getConfigPathFromArgs ?? getConfigPathFromArgs)(ctx.argv ?? []) ??
        getConfigPathFromArgs(process.argv.slice(2));
      let configProvenance: ConfigProvenance | undefined;
      let taskNative: TaskNativeReadiness | undefined;
      try {
        const cfg = (deps.loadConfig ?? loadConfig)(configPath);
        configProvenance = buildConfigProvenance(configPath, cfg, ctx.env);
        taskNative = (deps.resolveTaskNativeReadiness ?? resolveTaskNativeReadiness)(cfg);
      } catch {
        /* non-fatal — status works even without a valid config file */
      }

      const raw = await deps.gatherIntrospectionRaw({ argv: ctx.argv });
      const rollup = deps.assembleStatusRollupV1(raw, {
        includeDetail: Boolean(parsed.values.detail),
      });
      const payload: StatusPayload = {
        ...rollup,
        ...(configProvenance !== undefined ? { config: configProvenance } : {}),
        ...(taskNative !== undefined ? { taskNative } : {}),
      };
      emitResult(
        payload,
        (v) => humanStatus(v as StatusPayload),
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

const command: CommandModule = createStatusCommand();
export default command;
