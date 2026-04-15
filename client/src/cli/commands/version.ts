import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
import { getChainConfig } from '../../earning/contracts.js';
import { computeDeploymentDigest } from '../deployment-digest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(HERE, '..', '..', '..', 'package.json');

function readClientVersion(): string {
  const raw = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? '0.0.0';
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
        exampleCli: 'jinn version',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const configPath =
    getConfigPathFromArgs(ctx.argv ?? []) ?? getConfigPathFromArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  const chain = config.network === 'testnet' ? 'base-sepolia' : 'base';
  const chainConfig = getChainConfig(chain, {
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
  });

  /** Human-readable ERC-20 ticker; `address` is always `chainConfig.olasToken` (bond + reward role). */
  const bondRewardSymbol = chain === 'base' ? 'OLAS' : 'stOLAS';

  const { digest, artifacts } = computeDeploymentDigest(config);

  const payload = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    client: {
      version: readClientVersion(),
      commit: ctx.env['JINN_BUILD_COMMIT'] ?? 'unknown',
    },
    protocol: {
      phase: config.network === 'testnet' ? 'phase-1b' : 'phase-0',
      specVersion: 1 as const,
    },
    network: config.network,
    deployments: {
      digest,
      artifacts,
    },
    tokens: {
      native: { symbol: 'ETH', decimals: 18 },
      bond: { symbol: bondRewardSymbol, address: chainConfig.olasToken, decimals: 18 },
      reward: { symbol: bondRewardSymbol, address: chainConfig.olasToken, decimals: 18 },
    },
  };

  emitResult(payload, (v) => JSON.stringify(v, null, 2), {
    json: Boolean(parsed.values.json),
    human: Boolean(parsed.values.human),
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

const command: CommandModule = {
  name: 'version',
  summary: 'Print client version, protocol phase, and resolved token map',
  helpText: `Usage: jinn version [--human]

Prints a JSON object with the client version, protocol phase, current
network, deployment artifact digests, and the resolved token-role map.
This is the only verb (together with \`jinn fund-requirements\`) that
emits concrete token symbols and addresses — everywhere else uses role
names (native / bond / reward).

Examples:
  npx jinn version
  npx jinn version --human
`,
  run,
};

export default command;
