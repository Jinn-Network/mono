/**
 * Shared stack for jinn CLI verbs that need config + keystore + chain + signers (+ optional MechAdapter).
 * Mirrors {@link ../main.ts} bootstrap assumptions.
 */

import type { PublicClient } from 'viem';
import type { WalletClient } from 'viem';
import { loadConfig, getConfigPathFromArgs, type JinnConfig } from '../config.js';
import { getChainConfig, type ChainConfig } from '../earning/contracts.js';
import { FleetStateStore } from '../earning/store.js';
import type { FleetState, ServiceState } from '../earning/types.js';
import { decryptMnemonic, deriveMasterSigner, walletPrivateKeyAtIndex } from '../earning/wallet.js';
import { createJinnPublicClient, createJinnWalletClient } from '../earning/viem-clients.js';
import { MechAdapter } from '../adapters/mech/adapter.js';
import { Store } from '../store/store.js';
import type { BuildEnvelopeInput } from '../errors/envelope.js';
import { resolveCliPassword } from './password.js';

export type NetworkChain = 'base' | 'base-sepolia';

export interface CliSignerContext {
  config: JinnConfig;
  networkChain: NetworkChain;
  chainConfig: ChainConfig;
  fleetStore: FleetStateStore;
  mnemonic: string;
  fleetState: FleetState;
  publicClient: PublicClient;
  masterWallet: WalletClient;
}

export interface CliExecutionContext extends CliSignerContext {
  jinnStore: Store;
  /** First complete service with Safe + mech (daemon / creator semantics). */
  primaryService: ServiceState;
  adapter: MechAdapter;
}

function mergeArgvForConfig(argv?: string[]): string | undefined {
  return getConfigPathFromArgs(argv ?? []) ?? getConfigPathFromArgs(process.argv.slice(2));
}

export function pickPrimaryMechService(services: ServiceState[]): ServiceState | undefined {
  return services.find(s => s.step === 'complete' && s.safe_address && s.mech_address);
}

export type CreateCliExecutionContextOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

async function buildCliSignerContext(
  opts: CreateCliExecutionContextOptions,
): Promise<{ ok: true; ctx: CliSignerContext } | { ok: false; envelope: BuildEnvelopeInput }> {
  const env = opts.env ?? process.env;
  const pw = resolveCliPassword(opts.argv, env);
  if (!pw.ok) {
    return {
      ok: false,
      envelope: {
        code: 'invalid_invocation',
        message: pw.message,
        hint: 'Use JINN_PASSWORD or --password-fd N.',
        exampleCli: 'jinn submit-intent --id x --description "…" --yes',
        details: { field: 'keystore password' },
      },
    };
  }

  const config = loadConfig(mergeArgvForConfig(opts.argv));
  const networkChain: NetworkChain = config.network === 'testnet' ? 'base-sepolia' : 'base';
  const chainConfig = getChainConfig(networkChain, {
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    testnetClaimRegistryDeploymentPath: config.testnetClaimRegistryDeploymentPath,
  });

  const fleetStore = new FleetStateStore(config.earningDir);
  if (!fleetStore.hasMnemonicKeystore()) {
    return {
      ok: false,
      envelope: {
        code: 'bootstrap_incomplete',
        message: 'No mnemonic keystore found for this earning directory.',
        hint: 'Run `jinn bootstrap` once to generate the fleet wallet.',
        exampleCli: 'jinn bootstrap --json',
        details: { field: 'master_keystore.json' },
      },
    };
  }

  let mnemonic: string;
  try {
    mnemonic = await decryptMnemonic(await fleetStore.loadMnemonicKeystore(), pw.password);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      envelope: {
        code: 'invalid_invocation',
        message: 'Failed to decrypt the mnemonic keystore (wrong password?).',
        details: { field: 'JINN_PASSWORD', cause },
      },
    };
  }

  const fleetState = await fleetStore.load(networkChain);
  const publicClient = createJinnPublicClient(config.rpcUrl, networkChain);
  const masterAccount = deriveMasterSigner(mnemonic);
  const masterWallet = createJinnWalletClient(config.rpcUrl, networkChain, masterAccount);

  return {
    ok: true,
    ctx: {
      config,
      networkChain,
      chainConfig,
      fleetStore,
      mnemonic,
      fleetState,
      publicClient,
      masterWallet,
    },
  };
}

/** Password + config + mnemonic + master signer + fleet JSON (no MechAdapter). */
export async function createCliSignerContext(
  opts: CreateCliExecutionContextOptions = {},
): Promise<{ ok: true; ctx: CliSignerContext } | { ok: false; envelope: BuildEnvelopeInput }> {
  return buildCliSignerContext(opts);
}

export async function createCliExecutionContext(
  opts: CreateCliExecutionContextOptions = {},
): Promise<{ ok: true; ctx: CliExecutionContext } | { ok: false; envelope: BuildEnvelopeInput }> {
  const base = await buildCliSignerContext(opts);
  if (!base.ok) return base;

  const { config, chainConfig, mnemonic, fleetState, publicClient, masterWallet } = base.ctx;

  const primaryService = pickPrimaryMechService(fleetState.services);
  if (!primaryService?.safe_address || !primaryService.mech_address) {
    return {
      ok: false,
      envelope: {
        code: 'bootstrap_incomplete',
        message: 'No fleet service is complete with both a Safe and a mech address.',
        hint: 'Finish bootstrap through mech deployment, or configure testnet mech artifacts.',
        exampleCli: 'jinn bootstrap --json',
        details: { field: 'fleet' },
      },
    };
  }

  const jinnStore = new Store(config.dbPath);
  const agentEoaPrivateKey = walletPrivateKeyAtIndex(mnemonic, primaryService.index);
  const marketplaceAddress = chainConfig.mechMarketplace as `0x${string}`;
  const routerAddress = (chainConfig.jinnRouter ??
    '0xfFa7118A3D820cd4E820010837D65FAfF463181B') as `0x${string}`;

  const adapter = new MechAdapter(
    {
      rpcUrl: config.rpcUrl,
      mechMarketplaceAddress: marketplaceAddress,
      routerAddress,
      mechContractAddress: primaryService.mech_address as `0x${string}`,
      safeAddress: primaryService.safe_address as `0x${string}`,
      agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
      ipfsRegistryUrl: config.ipfsRegistryUrl,
      ipfsGatewayUrl: config.ipfsGatewayUrl,
      pollIntervalMs: config.pollIntervalMs,
      chainId: config.network === 'testnet' ? 84532 : 8453,
      routerClaimDeliveryVariant: chainConfig.routerClaimDeliveryVersion as 'v1' | 'v2',
    },
    jinnStore,
  );

  try {
    await adapter.initialize();
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      envelope: {
        code: 'transient_error',
        message: `Mech adapter initialization failed (RPC or network): ${cause}`,
        hint: 'Retry after the RPC endpoint is healthy.',
        exampleCli: 'jinn submit-intent --id x --description "…" --dry-run',
        details: { cause },
      },
    };
  }

  return {
    ok: true,
    ctx: {
      ...base.ctx,
      jinnStore,
      primaryService,
      adapter,
    },
  };
}
