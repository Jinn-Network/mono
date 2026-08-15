/**
 * Shared stack for jinn CLI verbs that need config + keystore + chain + signers (+ optional MechAdapter).
 * Mirrors {@link ../main.ts} bootstrap assumptions.
 */

import type { PublicClient } from 'viem';
import type { WalletClient } from 'viem';
import { loadConfig, getConfigPathFromArgs, type JinnConfig } from '../config.js';
import { getChainConfig, type ChainConfig } from '../earning/contracts.js';
import { getJinnRouterAddress } from '../contracts/addresses.js';
import { FleetStateStore } from '../earning/store.js';
import { isOperationalServiceStep, type FleetState, type ServiceState } from '../earning/types.js';
import { decryptMnemonic, deriveMasterSigner, walletPrivateKeyAtIndex } from '../earning/wallet.js';
import { base as baseChain, baseSepolia } from 'viem/chains';
import { createJinnPublicClient, createJinnWalletClient } from '../earning/viem-clients.js';
import { MechRequesterAdapter } from '../adapters/mech/requester-adapter.js';
import { createClients } from '../adapters/mech/safe.js';
import { createDirectSafeBroadcaster } from '../adapters/mech/direct-safe-broadcaster.js';
import { Store } from '../store/store.js';
import type { BuildEnvelopeInput } from '../errors/envelope.js';
import { resolveCliPassword } from './password.js';
import { checkDaemonGuard, daemonGuardEnvelope } from './daemon-guard.js';

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
  /**
   * Requester-only execution adapter — the CLI's `jinn tasks submit` posting
   * path. Carved off the full `MechAdapter` (one-swap R4) so the legacy mech
   * adapter can retire in Phase D without breaking the CLI; `TaskPostingService`
   * only ever calls `postTask` / `recoverTaskPost`.
   */
  adapter: MechRequesterAdapter;
}

function mergeArgvForConfig(argv?: string[]): string | undefined {
  return getConfigPathFromArgs(argv ?? []) ?? getConfigPathFromArgs(process.argv.slice(2));
}

export function pickPrimaryMechService(services: ServiceState[]): ServiceState | undefined {
  return services.find(s => isOperationalServiceStep(s.step) && s.safe_address && s.mech_address);
}

export type CreateCliExecutionContextOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

async function buildCliSignerContext(
  opts: CreateCliExecutionContextOptions,
  readOnlyFleet = false,
  willBroadcast = true,
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
        exampleCli: 'jinn tasks submit --id x --description "…" --solver-net prediction --yes',
        details: { field: 'keystore password' },
      },
    };
  }

  const config = loadConfig(mergeArgvForConfig(opts.argv));

  // D0a P3 (#525/#562/#897): every context built from this shared function
  // hands the caller live signer key material (`masterWallet`, and
  // `mnemonic` for deriving per-agent signers) that downstream code signs
  // Safe / EOA writes with — with no cross-process lock against a
  // concurrently running `jinn run` daemon signing from the same keys. Guard
  // once, here, rather than per verb: `createCliExecutionContext` used to
  // check this itself (after decrypting the mnemonic and loading fleet
  // state), which left `createCliSignerContext` callers (`jinn claim-rewards`)
  // unguarded — see the finding this comment replaces.
  //
  // D0a round-2 correction: the guard only makes sense when the caller will actually SIGN with
  // that key material. `createCliReadOnlySignerContext` (its one production caller is `jinn tasks
  // submit --dry-run`'s machine-request preflight) never signs or broadcasts — it only reads
  // fleet state to preview a plan — so guarding it was a pure false positive that fired in the
  // ordinary case of "operator's daemon is running, operator previews a submission" and had no
  // real safe escape (`JINN_ALLOW_CLI_BROADCAST_WITH_DAEMON=1`'s "you have verified it is safe to
  // run concurrently" is meaningless for something that broadcasts nothing). `willBroadcast`
  // lets a read-only, non-signing caller opt out explicitly instead of inheriting the guard by
  // accident.
  if (willBroadcast) {
    const daemonGuard = checkDaemonGuard({ earningDir: config.earningDir, env });
    if (daemonGuard.blocked) {
      return {
        ok: false,
        envelope: daemonGuardEnvelope(
          daemonGuard,
          'jinn tasks submit --id x --description "…" --solver-net prediction --yes',
        ),
      };
    }
  }

  const networkChain: NetworkChain = config.network === 'testnet' ? 'base-sepolia' : 'base';
  const chainConfig = getChainConfig(networkChain, {
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
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

  const fleetState = readOnlyFleet
    ? await fleetStore.tryLoadExisting()
    : await fleetStore.load(networkChain);
  if (!fleetState || (readOnlyFleet && fleetState.chain !== networkChain)) {
    return {
      ok: false,
      envelope: {
        code: 'bootstrap_incomplete',
        message: !fleetState
          ? 'No valid persisted fleet state is available for read-only validation.'
          : `Persisted fleet state is for ${fleetState.chain}, not ${networkChain}.`,
        hint: 'Run `jinn bootstrap` to create a valid fleet state before retrying.',
        exampleCli: 'jinn bootstrap --human',
        details: { field: 'fleet' },
      },
    };
  }
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

/**
 * Password + signers + existing fleet JSON, with no fleet-file creation or migration. Read-only —
 * never signs or broadcasts (`willBroadcast: false`), so it is not subject to the live-daemon
 * guard; see the D0a round-2 note on `buildCliSignerContext`.
 */
export async function createCliReadOnlySignerContext(
  opts: CreateCliExecutionContextOptions = {},
): Promise<{ ok: true; ctx: CliSignerContext } | { ok: false; envelope: BuildEnvelopeInput }> {
  return buildCliSignerContext(opts, true, false);
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

  // D0a P3 (#525/#562/#897): the daemon guard for this verb's signing runs
  // in `buildCliSignerContext` (above, via `base`) — it covers the
  // `createDirectSafeBroadcaster` write below too, since that broadcaster
  // signs with the same agent EOA derived from `base.ctx.mnemonic`.
  const jinnStore = new Store(config.dbPath);
  const agentEoaPrivateKey = walletPrivateKeyAtIndex(mnemonic, primaryService.index);
  const marketplaceAddress = chainConfig.mechMarketplace as `0x${string}`;
  const routerAddress = (chainConfig.jinnRouter ??
    getJinnRouterAddress(chainConfig.chainId)) as `0x${string}`;

  // Finding E16 / the C2 ruling: `jinn tasks submit` is a standalone one-shot process with no
  // composition root to borrow a broadcaster from, so it constructs its own — bound to this
  // service's own Safe, signed by this service's own agent EOA (the same signer this adapter's
  // Safe writes used before the venue-base cutover).
  const broadcasterChain = config.network === 'testnet' ? baseSepolia : baseChain;
  const broadcasterClients = createClients(
    config.rpcUrl,
    agentEoaPrivateKey as `0x${string}`,
    broadcasterChain,
  );
  const broadcaster = createDirectSafeBroadcaster(
    broadcasterClients.publicClient,
    broadcasterClients.walletClient,
    primaryService.safe_address as `0x${string}`,
  );

  const adapter = new MechRequesterAdapter({
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
    routerClaimDeliveryVariant: chainConfig.routerClaimDeliveryVersion,
    broadcaster,
  });

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
        exampleCli: 'jinn tasks submit --id x --description "…" --solver-net prediction --dry-run',
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
