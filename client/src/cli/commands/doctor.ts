import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { checkClaudeBinary, type ClaudeBinaryCheckResult } from '../../preflight/claude-binary.js';
import { detectAuthContext, probeClaudeAuth } from '../../preflight/claude-auth.js';
import { getConfigPathFromArgs, loadConfig, type JinnConfig } from '../../config.js';
import { getChainConfig } from '../../earning/contracts.js';
import { mnemonicKeystorePath } from '../../earning/store.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  const ok = major >= 20;
  return {
    name: 'node_version',
    ok,
    detail: `v${version}`,
    ...(ok ? {} : { remedy: 'Upgrade to Node.js 20 or newer.' }),
  };
}

function checkKeystorePresent(earningDir: string): CheckResult {
  const keystorePath = mnemonicKeystorePath(earningDir);
  if (existsSync(keystorePath)) {
    return {
      name: 'keystore_present',
      ok: true,
      detail: `mnemonic keystore present at ${keystorePath}`,
    };
  }
  return {
    name: 'keystore_present',
    ok: true, // Missing is fine before `jinn init`; `jinn run` / `bootstrap` will create it.
    detail: 'no keystore yet — run `jinn init` to create one',
  };
}

async function checkDeploymentLoaded(config: JinnConfig): Promise<CheckResult> {
  try {
    const chain = config.network === 'testnet' ? 'base-sepolia' : 'base';
    const cfg = getChainConfig(chain, {
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    });
    const hasMech = cfg.mechMarketplace !== '0x0000000000000000000000000000000000000000';
    return {
      name: 'deployment_loaded',
      ok: hasMech,
      detail: hasMech ? `resolved on ${chain}` : 'resolved deployment has no usable routing address',
      ...(hasMech
        ? {}
        : {
            remedy:
              'Update testnet deployment settings in your configuration file, or use a network with bundled deployment data.',
          }),
    };
  } catch {
    return {
      name: 'deployment_loaded',
      ok: false,
      detail: 'deployment configuration could not be loaded',
      remedy: 'Verify deployment-related settings in your configuration file.',
    };
  }
}

function claudeBinaryCheckForDoctor(claudePath: string, result: ClaudeBinaryCheckResult): CheckResult {
  const configuredAsPath = isAbsolute(claudePath) || claudePath.includes('/');
  const detail = result.ok
    ? configuredAsPath
      ? 'configured CLI path is present and executable'
      : 'CLI resolved on PATH'
    : configuredAsPath
      ? 'configured CLI path is missing or not executable'
      : 'CLI not found on PATH';
  return {
    name: 'claude_binary',
    ok: result.ok,
    detail,
    ...(result.ok
      ? {}
      : {
          remedy:
            'Install Claude Code or set an absolute path to the CLI in your configuration file.',
        }),
  };
}

async function checkClaudeAuth(): Promise<CheckResult> {
  const cwd = process.cwd();
  const context = detectAuthContext({ cwd });
  const probe = probeClaudeAuth({ context, cwd });
  return {
    name: 'claude_auth',
    ok: probe.authenticated,
    detail: probe.authenticated
      ? `${probe.detail} (${context})`
      : `Not authenticated (${context})`,
    ...(probe.authenticated
      ? {}
      : { remedy: 'Run `jinn auth` to authenticate Claude.' }),
  };
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: { ...COMMON_FLAGS },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn doctor',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const configPath =
    getConfigPathFromArgs(ctx.argv ?? []) ?? getConfigPathFromArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  const checks: CheckResult[] = [];

  checks.push(await checkNodeVersion());

  const claudeResult = await checkClaudeBinary(config.claudePath);
  checks.push(claudeBinaryCheckForDoctor(config.claudePath, claudeResult));
  checks.push(await checkClaudeAuth());

  checks.push(checkKeystorePresent(config.earningDir));
  checks.push(await checkDeploymentLoaded(config));

  const blockingCount = checks.filter((c) => !c.ok).length;
  const payload = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    checks,
    ok: blockingCount === 0,
    blockingCount,
  };

  emitResult(payload, (v) => humanDoctor(v as typeof payload), {
    json: Boolean(parsed.values.json),
    human: Boolean(parsed.values.human),
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

function humanDoctor(payload: {
  checks: CheckResult[];
  ok: boolean;
  blockingCount: number;
}): string {
  const lines: string[] = [];
  for (const check of payload.checks) {
    const mark = check.ok ? 'ok  ' : 'fail';
    lines.push(`[${mark}] ${check.name}: ${check.detail}`);
    if (check.remedy) lines.push(`       remedy: ${check.remedy}`);
  }
  lines.push(
    payload.ok
      ? 'Summary: all checks passed.'
      : `Summary: ${payload.blockingCount} blocking check(s) failed.`,
  );
  return lines.join('\n');
}

const command: CommandModule = {
  name: 'doctor',
  summary: 'Preflight checks: answers "would jinn run work?" without running it',
  helpText: `Usage: jinn doctor [--human] [--config <path>]

Runs a set of non-mutating checks against the local environment and
configuration:
  - node_version        Node.js >= 20
  - claude_binary       claude CLI resolvable on PATH
  - claude_auth         Claude CLI authenticated
  - keystore_present    mnemonic keystore in configured earning directory (optional)
  - deployment_loaded   testnet/mainnet contract addresses resolved

By default, emits a machine-readable JSON object with a checks array,
an overall ok flag, and a blockingCount. Exit code is 0 even when
checks fail — callers read the result to decide whether to proceed.

Examples:
  jinn doctor
  jinn doctor --human
`,
  run,
};

export default command;
