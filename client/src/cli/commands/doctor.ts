import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { checkClaudeBinary, type ClaudeBinaryCheckResult } from '../../preflight/claude-binary.js';
import { loadConfig, type JinnConfig } from '../../config.js';
import { getChainConfig } from '../../earning/contracts.js';

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

async function checkKeystoreReadable(earningDir: string): Promise<CheckResult> {
  const keystorePath = join(earningDir, 'mnemonic.keystore.json');
  if (existsSync(keystorePath)) {
    return {
      name: 'keystore_readable',
      ok: true,
      detail: 'mnemonic keystore present in configured earning directory',
    };
  }
  return {
    name: 'keystore_readable',
    ok: true, // Missing is fine before `jinn init`; not a blocker.
    detail: 'no keystore yet (expected on a fresh install)',
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

async function run(ctx: CommandContext): Promise<void> {
  const config = loadConfig();
  const checks: CheckResult[] = [];

  checks.push(await checkNodeVersion());

  const claudeResult = await checkClaudeBinary(config.claudePath);
  checks.push(claudeBinaryCheckForDoctor(config.claudePath, claudeResult));

  checks.push(await checkKeystoreReadable(config.earningDir));
  checks.push(await checkDeploymentLoaded(config));

  const blockingCount = checks.filter((c) => !c.ok).length;
  const payload = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    checks,
    ok: blockingCount === 0,
    blockingCount,
  };

  emitResult(payload, (v) => JSON.stringify(v, null, 2), {
    json: false,
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
  });
}

const command: CommandModule = {
  name: 'doctor',
  summary: 'Preflight checks: answers "would jinn run work?" without running it',
  helpText: `Usage: jinn doctor [--json]

Runs a set of non-mutating checks against the local environment and
configuration:
  - node_version        Node.js >= 20
  - claude_binary       claude CLI resolvable on PATH
  - keystore_readable   mnemonic keystore in configured earning directory (optional)
  - deployment_loaded   testnet/mainnet contract addresses resolved

Emits a JSON object with a checks array, an overall ok flag, and a
blockingCount. Exit code is 0 even when checks fail — callers read
the JSON to decide whether to proceed.

Examples:
  jinn doctor
  jinn doctor --json | jq '.ok'
`,
  run,
};

export default command;
