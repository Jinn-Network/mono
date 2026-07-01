import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { checkClaudeBinary as defaultCheckClaudeBinary, type ClaudeBinaryCheckResult } from '../../preflight/claude-binary.js';
import {
  detectAuthContext as defaultDetectAuthContext,
  probeClaudeAuth as defaultProbeClaudeAuth,
} from '../../preflight/claude-auth.js';
import {
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
  loadConfig as defaultLoadConfig,
  buildConfigProvenance,
  type JinnConfig,
} from '../../config.js';
import { getChainConfig, ERC20_ABI } from '../../earning/contracts.js';
import { runPortfolioV0DoctorChecks as defaultRunPortfolioV0DoctorChecks } from '../../api/portfolio-v0-doctor.js';
import { mnemonicKeystorePath } from '../../earning/store.js';
import {
  checkRpcNetwork as defaultCheckRpcNetwork,
  rpcNetworkFailureHint as defaultRpcNetworkFailureHint,
} from '../../preflight/rpc-network.js';
import {
  runDeploymentReadinessChecks as defaultRunDeploymentReadinessChecks,
  type DeploymentReadinessReport,
} from '../../preflight/deployment-readiness.js';
import { SOLVER_TYPES } from '../../solver-types/index.js';
import {
  resolveTaskNativeReadiness as defaultResolveTaskNativeReadiness,
  type TaskNativeReadiness,
} from '../task-native-readiness.js';

export interface DoctorDeps extends BaseCommandDeps {
  checkClaudeBinary: typeof defaultCheckClaudeBinary;
  checkRpcNetwork: typeof defaultCheckRpcNetwork;
  rpcNetworkFailureHint: typeof defaultRpcNetworkFailureHint;
  runPortfolioV0DoctorChecks: typeof defaultRunPortfolioV0DoctorChecks;
  /** Probes the distributor's OLAS balance via real RPC; tests inject a fake to avoid network hangs. */
  checkDistributorReachable: (config: JinnConfig) => Promise<CheckResult | null>;
  /** Detects whether claude runs in a container/compose/bare context. */
  detectAuthContext: typeof defaultDetectAuthContext;
  /** Probes claude auth status via subprocess; tests inject a fake to avoid spawning claude. */
  probeClaudeAuth: typeof defaultProbeClaudeAuth;
  /** Local-only Task-native deployment/config readiness check. */
  resolveTaskNativeReadiness?: (config: JinnConfig) => TaskNativeReadiness;
  /** Deployment-readiness aggregate (#958); tests inject a fake to avoid fs/network probes. */
  runDeploymentReadinessChecks?: typeof defaultRunDeploymentReadinessChecks;
}

const PRODUCTION_DEPS: DoctorDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  checkClaudeBinary: defaultCheckClaudeBinary,
  checkRpcNetwork: defaultCheckRpcNetwork,
  rpcNetworkFailureHint: defaultRpcNetworkFailureHint,
  runPortfolioV0DoctorChecks: defaultRunPortfolioV0DoctorChecks,
  checkDistributorReachable,
  detectAuthContext: defaultDetectAuthContext,
  probeClaudeAuth: defaultProbeClaudeAuth,
  runDeploymentReadinessChecks: defaultRunDeploymentReadinessChecks,
};

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
  /** `rpc_network` only: preflight used loopback Anvil/Hardhat chain id, not Base. */
  rpcStatus?: 'matched' | 'local_dev_override';
  /** `rpc_network` only: machine-readable context (avoid parsing `detail` for automation). */
  rpc?: {
    host: string;
    network: 'mainnet' | 'testnet';
    expectedChainId: number;
    actualChainId: number;
  };
  taskNative?: {
    solverReady: boolean;
    evaluatorReady: boolean;
    evaluatorRoleReady: boolean;
    distinctEvaluatorServiceReady: boolean;
    source: string | null;
    contracts: {
      taskCoordinator?: string;
      jinnRouterV3?: string;
      taskActivityCheckerV3?: string;
    };
    routerClaimDeliveryVersion?: 'v1' | 'v2' | 'v3';
    operatorState?: TaskNativeReadiness['operatorState'];
  };
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
      detail: hasMech
        ? `resolved on ${chain}`
        : 'resolved deployment has no usable routing address',
      ...(hasMech
        ? {}
        : {
            remedy:
              'Update deployment settings in your configuration file, or use a network with bundled deployment data.',
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

function taskNativeCheckForDoctor(readiness: TaskNativeReadiness): CheckResult {
  return {
    name: 'task_native_deployment',
    ok: readiness.ok,
    detail: readiness.detail,
    ...(readiness.remedy ? { remedy: readiness.remedy } : {}),
    taskNative: {
      solverReady: readiness.solverReady,
      evaluatorReady: readiness.evaluatorReady,
      evaluatorRoleReady: readiness.evaluatorRoleReady,
      distinctEvaluatorServiceReady: readiness.distinctEvaluatorServiceReady,
      source: readiness.source,
      contracts: readiness.contracts,
      ...(readiness.routerClaimDeliveryVersion
        ? { routerClaimDeliveryVersion: readiness.routerClaimDeliveryVersion }
        : {}),
      ...(readiness.operatorState ? { operatorState: readiness.operatorState } : {}),
    },
  };
}

/**
 * Map the deployment-readiness aggregate (#958) into doctor `CheckResult`s.
 * These always appear in `doctor` output regardless of context; the report's
 * `deployment` flag is reflected in the volume check's detail so the operator
 * can see whether the boot gate would be armed.
 */
function deploymentReadinessChecksForDoctor(report: DeploymentReadinessReport): CheckResult[] {
  return report.checks.map((c) => ({
    name: c.name,
    ok: c.ok,
    detail: c.detail,
    ...(c.remedy ? { remedy: c.remedy } : {}),
  }));
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

/**
 * Verify the daemon can spawn its HL MCP subprocess. The generated
 * `hl-server.mjs` wrapper imports `mcp-tools.js` by absolute path and is
 * loaded by plain Node — so the compiled artifact MUST exist on disk
 * before `jinn run` spawns any Claude session. Without this check, the
 * operator hits a silent "Claude didn't call any tools" symptom.
 */
function checkDaemonRuntimeReady(): CheckResult {
  // doctor.ts compiles to dist/cli/commands/doctor.js → package root is 3 levels up.
  // Under tsx (dev), __dirname is src/cli/commands; the check then looks for a sibling
  // built artifact under dist/, which will only exist after `yarn build`.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const mcpToolsJsDist = join(thisDir, '..', '..', 'harnesses', 'impls', 'claude-mcp-hyperliquid', 'mcp-tools.js');
  if (existsSync(mcpToolsJsDist)) {
    return {
      name: 'daemon_runtime_ready',
      ok: true,
      detail: `compiled MCP tool module present at ${mcpToolsJsDist}`,
    };
  }
  return {
    name: 'daemon_runtime_ready',
    ok: false,
    detail: `compiled MCP tool module missing (expected ${mcpToolsJsDist})`,
    remedy:
      'The daemon must run from a compiled build. Run `yarn build` before `yarn dev` / `node dist/bin/jinn.js run`, ' +
      'or reinstall the npm package with `npm install -g @jinn-network/client@latest`.',
  };
}

/**
 * On testnet, warn if the stOLAS distributor pool is drained. Operators can
 * neither fix this themselves nor bootstrap past it — the protocol team has
 * to refill the distributor. Emitted as a warning, not a hard failure,
 * because a refill may be in-flight.
 */
async function checkDistributorReachable(config: JinnConfig): Promise<CheckResult | null> {
  if (config.network !== 'testnet') return null;
  try {
    const cfg = getChainConfig('base-sepolia', {
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    });
    if (!cfg.distributorAddress) {
      return {
        name: 'distributor_reachable',
        ok: true,
        detail: 'distributor address not configured (standard mode staking disabled)',
      };
    }
    const client = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
    const balance = await client.readContract({
      address: cfg.olasToken as Address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [cfg.distributorAddress as Address],
    });
    const floor = cfg.bondAmount * 2n;
    const jinn = Number(balance) / 1e18;
    const required = Number(floor) / 1e18;
    if (balance < floor) {
      return {
        name: 'distributor_reachable',
        ok: false,
        detail: `testnet staking pool is drained — distributor holds ${jinn.toFixed(2)} tJINN, need ≥${required.toFixed(2)} per service`,
        remedy:
          'Protocol-team action required (operators cannot fix this locally). ' +
          'Report the outage to the Jinn testnet channel; bootstrap will keep failing with `Overflow` until the pool is topped up.',
      };
    }
    return {
      name: 'distributor_reachable',
      ok: true,
      detail: `distributor holds ${jinn.toFixed(2)} tJINN (${Math.floor(jinn / required)} services of runway)`,
    };
  } catch (err) {
    return {
      name: 'distributor_reachable',
      ok: true, // Non-fatal — probe failure doesn't mean the pool is empty.
      detail: `distributor probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function createDoctorCommand(deps: DoctorDeps = PRODUCTION_DEPS): CommandModule {
  async function checkRpcNetworkForDoctor(config: JinnConfig): Promise<CheckResult> {
    const result = await deps.checkRpcNetwork(config);
    if (result.ok) {
      const detail = result.localDev
        ? `${result.rpcHost} reports chainId ${result.actualChainId} for config network ${result.network} (local loopback; Anvil/Hardhat id, not Base ${result.expectedChainId} — expected for local forks).`
        : `${result.rpcHost} reports chain ${result.actualChainId} for ${result.network}`;
      return {
        name: 'rpc_network',
        ok: true,
        detail,
        rpcStatus: result.localDev ? 'local_dev_override' : 'matched',
        rpc: {
          host: result.rpcHost,
          network: result.network,
          expectedChainId: result.expectedChainId,
          actualChainId: result.actualChainId,
        },
      };
    }
    return {
      name: 'rpc_network',
      ok: false,
      detail: result.message,
      remedy: deps.rpcNetworkFailureHint(result),
    };
  }

  async function checkClaudeAuth(config: JinnConfig): Promise<CheckResult> {
    const cwd = process.cwd();
    const context = deps.detectAuthContext({ cwd, configuredMode: config.runtimeMode });
    const probe = deps.probeClaudeAuth({ context, cwd, claudePath: config.claudePath });
    return {
      name: 'claude_auth',
      ok: probe.authenticated,
      detail: probe.authenticated
        ? `${probe.detail} (${context})`
        : `Not authenticated (${context})`,
      ...(probe.authenticated
        ? {}
        : { remedy: 'Run `jinn run` and complete Claude setup in the operator app.' }),
    };
  }

  return {
    name: 'doctor',
    summary: 'Preflight checks: answers "would jinn run work?" without running it',
    helpText: `Usage: jinn doctor [--human] [--config <path>]

Runs a set of non-mutating checks against the local environment and
configuration:
  - node_version                Node.js >= 20
  - claude_binary               claude CLI resolvable on PATH
  - claude_auth                 Claude CLI authenticated
  - keystore_present            mnemonic keystore in configured earning directory (optional)
  - deployment_loaded           testnet/mainnet contract addresses resolved
  - task_native_deployment      TaskCoordinator/JinnRouterV3/TaskActivityCheckerV3 local readiness
  - writable_volume             state directory is writable (write+fsync+unlink probe)
  - state_on_volume             state resolves under JINN_STATE_DIR in a deployment context
  - credentials_resolvable      agent-CLI credentials resolvable (presence-only; no secret echo)
  - agent_cli_non_root          daemon not running as root (uid 0)
  - portfolio_impl_state_dir    HL impl state directory present and readable
  - hl_api_wallet               HL API wallet generated and approved by operator

By default, emits a machine-readable JSON object with a checks array,
an overall ok flag, and a blockingCount. Exit code is 0 even when
checks fail — callers read the result to decide whether to proceed.

Examples:
  jinn doctor
  jinn doctor --human
`,
    async run(ctx: CommandContext): Promise<void> {
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
        deps.getConfigPathFromArgs(ctx.argv ?? []) ?? deps.getConfigPathFromArgs(process.argv.slice(2));
      const config = deps.loadConfig(configPath);
      const checks: CheckResult[] = [];

      checks.push(await checkNodeVersion());

      const claudeResult = await deps.checkClaudeBinary(config.claudePath);
      checks.push(claudeBinaryCheckForDoctor(config.claudePath, claudeResult));
      checks.push(await checkClaudeAuth(config));

      checks.push(checkKeystorePresent(config.earningDir));
      checks.push(await checkRpcNetworkForDoctor(config));
      checks.push(await checkDeploymentLoaded(config));
      checks.push(taskNativeCheckForDoctor((deps.resolveTaskNativeReadiness ?? defaultResolveTaskNativeReadiness)(config)));
      checks.push(checkDaemonRuntimeReady());

      // Deployment-readiness aggregate (#958). Always reported here; the boot
      // gate in main.ts only fails loud on hard checks in a deployment context.
      const deploymentReport = await (deps.runDeploymentReadinessChecks ?? defaultRunDeploymentReadinessChecks)(
        {
          stateDir: config.stateDir,
          earningDir: config.earningDir,
          runtimeMode: config.runtimeMode,
        },
        {
          env: ctx.env,
          getuid: typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined,
          detectAuthContext: deps.detectAuthContext,
        },
      );
      checks.push(...deploymentReadinessChecksForDoctor(deploymentReport));

      const distributorCheck = await deps.checkDistributorReachable(config);
      if (distributorCheck) checks.push(distributorCheck);

      // portfolio.v0 checks — only run if the operator has configured a
      // portfolio.v0 Task. Otherwise, reporting `hl_api_wallet: fail`
      // on a fresh operator who hasn't submitted an HL task is false-alarm
      // noise. Operators who want the HL-specific preflight in isolation can
      // run those checks under a dedicated verb once one exists.
      const portfolioKind = SOLVER_TYPES['portfolio.v0']!.solverType;
      const hasPortfolioV0 = config.tasks.some((d) => d.solverType === portfolioKind);
      if (hasPortfolioV0) {
        const implStateDirRoot = config.engine.implStateDirRoot;
        const hlImplStateDir = join(implStateDirRoot, 'claude-mcp-hyperliquid');
        const portfolioChecks = deps.runPortfolioV0DoctorChecks(hlImplStateDir);
        checks.push(...portfolioChecks);
      }

      const blockingCount = checks.filter((c) => !c.ok).length;
      const provenance = buildConfigProvenance(configPath, config, ctx.env);
      const payload = {
        schemaVersion: 1 as const,
        generatedAt: new Date().toISOString(),
        config: provenance,
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
    },
  };
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

const command: CommandModule = createDoctorCommand();
export default command;
