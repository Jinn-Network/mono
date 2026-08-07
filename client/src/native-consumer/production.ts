/**
 * Production wiring for `jinn native-vertical consume`: loads the consumer config file from disk,
 * builds the real Base Sepolia RPC reader and the real (public, signed) trust catalog, runs the
 * driver, and optionally copies the canonical report to an additional `--out` path.
 */
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { createBaseSepoliaConsumerChainReader } from './chain-facts.js';
import { NativeConsumerConfigError, parseNativeConsumerConfig, type NativeConsumerConfig } from './config.js';
import { runNativeConsumer, type NativeConsumerRunResult } from './driver.js';
import {
  createBaseSepoliaFinalizedAnchorClient,
  createViemBaseSepoliaReadClients,
} from '../daemon/native-base-sepolia-infrastructure.js';
import { openNativeTrustCatalog } from '../daemon/native-trust-catalog.js';
import { createPublicClient, http, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';

/**
 * Loading/parsing failures here (missing file, malformed JSON, schema violations) are an
 * `invalid_invocation` -- the operator's config is wrong -- never a `fatal` verification failure.
 * `parseNativeConsumerConfig` already throws `NativeConsumerConfigError` for schema violations;
 * this wraps the two I/O failure modes in the same typed error so the CLI can classify by name
 * alone, without importing native-consumer internals.
 */
export async function loadNativeConsumerConfig(path: string): Promise<NativeConsumerConfig> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new NativeConsumerConfigError(`native consumer config at ${path} could not be read: ${String(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new NativeConsumerConfigError(`native consumer config at ${path} is not valid JSON: ${String(cause)}`);
  }
  return parseNativeConsumerConfig(parsed);
}

async function writeReportCopy(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'w', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

export async function runNativeConsumerCommand(input: {
  readonly configPath: string;
  readonly outPath?: string;
}): Promise<{
  readonly runId: string;
  readonly reportPath: string;
  readonly reportDigest: `sha256:${string}`;
  readonly syncModes: NativeConsumerRunResult['syncModes'];
}> {
  const config = await loadNativeConsumerConfig(input.configPath);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) }) as PublicClient;
  const { anchor, settlementOwnership } = createViemBaseSepoliaReadClients(publicClient);
  const trust = await openNativeTrustCatalog({
    path: config.trustRootsPath,
    expectedPolicyGenesisDigest: config.policyGenesisDigest as `sha256:${string}`,
    anchorClient: createBaseSepoliaFinalizedAnchorClient(anchor),
    settlementOwnershipClient: settlementOwnership,
  });
  const chain = createBaseSepoliaConsumerChainReader({ rpcUrl: config.rpcUrl });

  const result = await runNativeConsumer(config, { trust, chain });
  if (input.outPath !== undefined) {
    const bytes = await readFile(result.reportPath);
    await writeReportCopy(input.outPath, bytes);
  }
  return {
    runId: config.runId,
    reportPath: result.reportPath,
    reportDigest: result.reportDigest,
    syncModes: result.syncModes,
  };
}
