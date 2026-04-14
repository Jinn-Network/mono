import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { loadConfig } from '../../config.js';
import { getChainConfig } from '../../earning/contracts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(HERE, '..', '..', '..', 'package.json');

function readClientVersion(): string {
  const raw = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? '0.0.0';
}

async function run(ctx: CommandContext): Promise<void> {
  const config = loadConfig();
  const chain = config.network === 'testnet' ? 'base-sepolia' : 'base';
  const chainConfig = getChainConfig(chain, {
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
  });

  /** Human-readable ERC-20 ticker; `address` is always `chainConfig.olasToken` (bond + reward role). */
  const bondRewardSymbol = chain === 'base' ? 'OLAS' : 'stOLAS';

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
      digest: 'unknown',
      artifacts: [] as Array<{ name: string; path: string; sha256: string }>,
    },
    tokens: {
      native: { symbol: 'ETH', decimals: 18 },
      bond: { symbol: bondRewardSymbol, address: chainConfig.olasToken, decimals: 18 },
      reward: { symbol: bondRewardSymbol, address: chainConfig.olasToken, decimals: 18 },
    },
  };

  emitResult(payload, (v) => JSON.stringify(v, null, 2), {
    json: false,
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
  });
}

const command: CommandModule = {
  name: 'version',
  summary: 'Print client version, protocol phase, and resolved token map',
  helpText: `Usage: jinn version [--json]

Prints a JSON object with the client version, protocol phase, current
network, deployment artifact digests, and the resolved token-role map.
This is the only verb (together with \`jinn fund-requirements\`) that
emits concrete token symbols and addresses — everywhere else uses role
names (native / bond / reward).

Examples:
  jinn version
  jinn version --json
`,
  run,
};

export default command;
