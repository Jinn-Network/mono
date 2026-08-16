/**
 * Client-owned, operator-only authorization surface for curated seed batches.
 *
 * Preview is the default and performs no network or seed-state writes. Live
 * publication requires --yes, a mechanically clean candidate directory, and
 * an exact report produced from the current candidate content.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  auditCuratedSeedBatch,
  createLocalEpisodeSeedSource,
  parseEpisodeImportReport,
  planEpisodes,
  runJinnLayerCli,
  type HarnessPublishDeps,
  type RunJinnLayerCliOptions,
} from '@jinn-network/jinn-layer';
import { loadConfig } from '../src/config.js';
import { parseRpcUrls } from '../src/rpc/transport.js';
import {
  createLivePublishDeps,
  createManifestAnchorStore,
  DEFAULT_TESTNET_IDENTITY_REGISTRY,
  DEFAULT_TESTNET_RPC_URL,
} from './layer-live-deps.js';
import {
  deriveOperatorIdentity,
  type OperatorIdentity,
} from './layer-operator-identity.js';

const REPO_SLUG = 'Jinn-Network/mono';
const BASE_SEPOLIA_CHAIN_ID = 84532;
const MAX_CURATED_EPISODE_FILES = 100;
const MAX_CURATED_EPISODE_BYTES = 1_048_576;

export interface CuratedSeedPublisherArgs {
  episodesDir: string;
  reportPath: string;
  passwordFd?: number;
  json: boolean;
  yes: boolean;
}

export interface CuratedSeedPublisherRuntime {
  stdout?(text: string): void;
  stderr?(text: string): void;
  env?: NodeJS.ProcessEnv;
  deriveOperatorIdentity?(
    argv: readonly string[],
  ): Promise<OperatorIdentity>;
  createPublishDeps?(identity: OperatorIdentity): HarnessPublishDeps;
  runLayerCli?(
    argv: readonly string[],
    options: RunJinnLayerCliOptions,
  ): Promise<number>;
}

function takeValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseCuratedSeedPublisherArgs(
  argv: readonly string[],
): CuratedSeedPublisherArgs {
  let episodesDir: string | undefined;
  let reportPath: string | undefined;
  let passwordFd: number | undefined;
  let json = false;
  let yes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--episodes-dir':
        episodesDir = takeValue(argv, index, arg);
        index += 1;
        break;
      case '--report':
        reportPath = takeValue(argv, index, arg);
        index += 1;
        break;
      case '--password-fd': {
        const raw = takeValue(argv, index, arg);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error('--password-fd must be a non-negative integer');
        }
        passwordFd = parsed;
        index += 1;
        break;
      }
      case '--json':
        json = true;
        break;
      case '--yes':
        yes = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!episodesDir) throw new Error('--episodes-dir is required');
  if (!reportPath) throw new Error('--report is required');
  return {
    episodesDir,
    reportPath,
    ...(passwordFd === undefined ? {} : { passwordFd }),
    json,
    yes,
  };
}

function assertApprovedReportMatches(
  approved: ReturnType<typeof parseEpisodeImportReport>,
  current: Awaited<ReturnType<typeof planEpisodes>>,
): void {
  if (approved.length !== current.length) {
    throw new Error(
      'approved report does not match the current candidate batch: record count changed',
    );
  }
  for (let index = 0; index < current.length; index += 1) {
    const approvedRow = approved[index];
    const currentRow = current[index];
    if (
      !approvedRow ||
      !currentRow ||
      approvedRow.id !== currentRow.id ||
      approvedRow.taskSummary !== currentRow.taskSummary ||
      JSON.stringify(approvedRow.tags) !== JSON.stringify(currentRow.tags) ||
      approvedRow.contentDigest !== currentRow.contentDigest ||
      approvedRow.verdict !== 'import' ||
      currentRow.verdict !== 'import'
    ) {
      throw new Error(
        'approved report does not match the current candidate batch; regenerate and re-approve the seed plan',
      );
    }
  }
}

function previewPayload(
  identity: OperatorIdentity,
  report: ReturnType<typeof parseEpisodeImportReport>,
) {
  return {
    schemaVersion: 'jinn.curated-seed-publish-preview.v1' as const,
    mode: 'preview' as const,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    operator: {
      safeAddress: identity.safeAddress,
      agentId: identity.agentId.toString(),
      agentAddress: identity.agentAddress,
      serviceIndex: identity.serviceIndex,
    },
    recordCount: report.length,
    records: report.map((row) => ({
      id: row.id,
      contentDigest: row.contentDigest,
    })),
  };
}

function renderPreview(
  payload: ReturnType<typeof previewPayload>,
): string {
  return [
    `network: Base Sepolia (${payload.chainId})`,
    `operator: ${payload.operator.agentAddress} (service index ${payload.operator.serviceIndex})`,
    `safe: ${payload.operator.safeAddress}`,
    `agentId: ${payload.operator.agentId}`,
    `approved records: ${payload.recordCount}`,
    ...payload.records.map(
      (record) => `  ${record.id}  ${record.contentDigest}`,
    ),
  ].join('\n');
}

function defaultPublishDeps(
  identity: OperatorIdentity,
  env: NodeJS.ProcessEnv,
): HarnessPublishDeps {
  const config = loadConfig();
  const rpcUrls = parseRpcUrls(
    env['JINN_RPC_URL'] ?? config.rpcUrl ?? DEFAULT_TESTNET_RPC_URL,
  );
  return createLivePublishDeps({
    privateKey: identity.privateKey,
    safeAddress: identity.safeAddress,
    agentId: identity.agentId,
    rpcUrl: rpcUrls[0],
    identityRegistry:
      (env['JINN_LAYER_IDENTITY_REGISTRY'] as
        | `0x${string}`
        | undefined) ?? DEFAULT_TESTNET_IDENTITY_REGISTRY,
    ipfsRegistryUrl:
      env['JINN_IPFS_REGISTRY_URL'] ?? config.ipfsRegistryUrl,
    ipfsGatewayUrl:
      env['JINN_IPFS_GATEWAY_URL'] ?? config.ipfsGatewayUrl,
    endpoint:
      env['JINN_LAYER_ENDPOINT'] ??
      `http://127.0.0.1:${config.apiPort}`,
    ledgerPath: env['JINN_LAYER_LEDGER_PATH'],
    store: createManifestAnchorStore(config.dbPath),
  });
}

export async function runCuratedSeedPublisher(
  argv: readonly string[],
  runtime: CuratedSeedPublisherRuntime = {},
): Promise<number> {
  const stdout = runtime.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  const env = runtime.env ?? process.env;

  try {
    const args = parseCuratedSeedPublisherArgs(argv);
    const source = createLocalEpisodeSeedSource(resolve(args.episodesDir), {
      maxFiles: MAX_CURATED_EPISODE_FILES,
      maxFileBytes: MAX_CURATED_EPISODE_BYTES,
      rejectSymlinks: true,
    });
    const episodes = await source.list();
    const audit = await auditCuratedSeedBatch({
      repoSlug: REPO_SLUG,
      episodes,
    });
    if (
      audit.automatedStatus !== 'pass' ||
      audit.eligibleRecordCount !== episodes.length
    ) {
      stderr(
        `curated seed publication refused: automated audit failed (${audit.eligibleRecordCount}/${episodes.length} eligible)\n`,
      );
      for (const error of audit.errors) stderr(`  ${error}\n`);
      return 1;
    }

    const approved = parseEpisodeImportReport(
      JSON.parse(readFileSync(resolve(args.reportPath), 'utf8')),
    );
    const current = await planEpisodes({
      name: source.name,
      list: async () => episodes,
    });
    assertApprovedReportMatches(approved, current);

    const identityResolver =
      runtime.deriveOperatorIdentity ??
      ((identityArgv: readonly string[]) =>
        deriveOperatorIdentity(identityArgv, { env }));
    const identity = await identityResolver(argv);
    const preview = previewPayload(identity, approved);

    if (args.json && !args.yes) {
      stdout(`${JSON.stringify(preview, null, 2)}\n`);
    } else {
      stderr(`${renderPreview(preview)}\n`);
    }

    if (!args.yes) {
      if (!args.json) {
        stderr(
          '\npreview only — no IPFS, RPC, chain, ledger, or seed-state writes. Re-run with --yes to publish.\n',
        );
      }
      return 0;
    }

    const publishDeps = (
      runtime.createPublishDeps ??
      ((operatorIdentity: OperatorIdentity) =>
        defaultPublishDeps(operatorIdentity, env))
    )(identity);
    const layerArgs = [
      'seed',
      'execute',
      resolve(args.reportPath),
      '--episodes-dir',
      resolve(args.episodesDir),
      ...(args.json ? ['--json'] : []),
    ];
    const runLayerCli = runtime.runLayerCli ?? runJinnLayerCli;
    return await runLayerCli(layerArgs, {
      publishDeps,
      writer: {
        write(value: string) {
          stdout(value);
          return true;
        },
      },
    });
  } catch (error) {
    stderr(
      `curated seed publication refused: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  return runCuratedSeedPublisher(argv);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
