/**
 * The chain-touching half of `jinn ceremony` (spec/2026-08-07-native-identity-ceremony.md §4.1
 * steps 1 and 4): the operator's existing OLAS earning custody, the `Safe.isOwner` preflight, and
 * the anchor submit / finality wait.
 *
 * It lives beside the earning stack rather than in the CLI because everything it reads is earning
 * state: the encrypted mnemonic keystore, `earning_state.json`, and the derived per-service agent
 * EOA. The ceremony does NOT create chain identity — it binds native role keys to the agent EOA and
 * service Safe an operator already has, which is why `readCeremonyChainCustody` refuses rather than
 * bootstrapping when that identity is absent.
 *
 * The CLI injects all of this as deps, so the command's own tests never decrypt a keystore or open
 * a socket; this module is the production wiring behind those seams.
 */

import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  anchorDeclaration,
  submitAnchor,
  waitForFinalizedAnchor,
  type AnchorLocator,
  type FinalizedAnchorObservation,
} from '@jinn-network/trust-authoring';
import { privateKeyToAccount } from 'viem/accounts';

import { FleetStateStore } from './store.js';
import { decryptMnemonic, walletPrivateKeyAtIndex } from './wallet.js';
import { SAFE_ABI } from '../contracts/abis.js';
import { isOperationalServiceStep } from './types.js';
import {
  createBaseSepoliaFinalizedAnchorClient,
  createViemBaseSepoliaReadClients,
} from '../daemon/native-base-sepolia-infrastructure.js';

export class CeremonyCustodyError extends Error {
  override readonly name = 'CeremonyCustodyError';
}

export interface CeremonyChainCustody {
  readonly serviceIndex: number;
  readonly agentEoa: `0x${string}`;
  readonly safeAddress: `0x${string}`;
}

function earningDirFor(dir: string): string {
  return `${dir.replace(/\/+$/u, '')}/earning`;
}

function publicClientFor(rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl ?? baseSepolia.rpcUrls.default.http[0]),
  }) as PublicClient;
}

/**
 * Reads the agent EOA and service Safe from `earning_state.json`. No password and no key material:
 * this runs on the ceremony's read-only plan path, so an operator can see exactly which identity a
 * ceremony would bind before authorizing anything.
 */
export async function readCeremonyChainCustody(input: {
  readonly dir: string;
  readonly serviceIndex?: number;
}): Promise<CeremonyChainCustody> {
  const store = new FleetStateStore(earningDirFor(input.dir));
  const state = await store.tryLoadExisting();
  if (state === null) {
    throw new CeremonyCustodyError(
      `no earning state at ${earningDirFor(input.dir)}; run \`jinn bootstrap\` before the ceremony`,
    );
  }
  const service = input.serviceIndex === undefined
    ? state.services.find((candidate) => isOperationalServiceStep(candidate.step) && candidate.safe_address !== null)
    : state.services.find((candidate) => candidate.index === input.serviceIndex);
  if (service === undefined) {
    throw new CeremonyCustodyError(
      input.serviceIndex === undefined
        ? 'no operational service with a deployed Safe was found in the earning state'
        : `no service with index ${input.serviceIndex} in the earning state`,
    );
  }
  if (service.safe_address === null || service.safe_address.length === 0) {
    throw new CeremonyCustodyError(`service ${service.index} has no deployed Safe yet`);
  }
  return {
    serviceIndex: service.index,
    agentEoa: service.agent_address as `0x${string}`,
    safeAddress: service.safe_address as `0x${string}`,
  };
}

/**
 * `Safe.isOwner(agentEoa)` — the second link of the §2.2 chain of custody, and the only one that is
 * honestly chain-state-dependent. The ceremony checks it BEFORE minting anything: without it every
 * settlement this operator later seals would refuse verification, and the operator would have paid
 * anchor gas and sealed a catalog to find that out.
 */
export async function verifyCeremonySafeOwnership(input: {
  readonly safeAddress: `0x${string}`;
  readonly agentEoa: `0x${string}`;
  readonly rpcUrl?: string;
}): Promise<boolean> {
  const client = publicClientFor(input.rpcUrl);
  return client.readContract({
    address: input.safeAddress,
    abi: SAFE_ABI,
    functionName: 'isOwner',
    args: [input.agentEoa],
  }) as Promise<boolean>;
}

export interface CeremonyAnchorSession {
  signMessage(input: { readonly message: { readonly raw: Uint8Array } }): Promise<`0x${string}`>;
  submit(digest: `sha256:${string}`): Promise<AnchorLocator>;
  waitForFinalized(input: {
    readonly digest: `sha256:${string}`;
    readonly locator: AnchorLocator;
    readonly timeoutMs: number;
    readonly pollMs: number;
    readonly onProgress?: (elapsedMs: number) => void;
  }): Promise<FinalizedAnchorObservation>;
  close?(): Promise<void>;
}

/**
 * Decrypts the operator's mnemonic, derives the service's agent EOA, and returns the one session
 * that both signs ceremonies and anchors them.
 *
 * The derived address is checked against `earning_state.json`'s recorded `agent_address`. A
 * mismatch means the keystore and the state file describe different operators — a ceremony run
 * against that would bind keys vouched by an EOA the Safe does not know, which the §2 check would
 * then reject at every settlement.
 */
export async function openCeremonyAnchorSession(input: {
  readonly dir: string;
  readonly serviceIndex: number;
  readonly password: string;
  readonly anchorTarget: `0x${string}`;
  readonly rpcUrl?: string;
}): Promise<CeremonyAnchorSession> {
  const custody = await readCeremonyChainCustody({ dir: input.dir, serviceIndex: input.serviceIndex });
  const store = new FleetStateStore(earningDirFor(input.dir));
  let mnemonic: string;
  try {
    mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), input.password);
  } catch (cause) {
    throw new CeremonyCustodyError(
      `the operator keystore at ${earningDirFor(input.dir)} could not be decrypted with the supplied password: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const account = privateKeyToAccount(walletPrivateKeyAtIndex(mnemonic, input.serviceIndex));
  if (account.address.toLowerCase() !== custody.agentEoa.toLowerCase()) {
    throw new CeremonyCustodyError(
      `keystore-derived EOA ${account.address} does not match the earning state's agent address ${custody.agentEoa} `
        + `for service ${input.serviceIndex}`,
    );
  }

  const publicClient = publicClientFor(input.rpcUrl);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(input.rpcUrl ?? baseSepolia.rpcUrls.default.http[0]),
  });
  const anchorClient = createBaseSepoliaFinalizedAnchorClient(
    createViemBaseSepoliaReadClients(publicClient).anchor,
  );

  return {
    signMessage: (message) => account.signMessage(message),
    submit: (digest) => submitAnchor({
      walletClient: {
        sendTransaction: (tx) => walletClient.sendTransaction({ ...tx, account, chain: baseSepolia }),
      },
      publicClient: {
        waitForTransactionReceipt: (receipt) => publicClient.waitForTransactionReceipt(receipt),
        getBlock: (block) => publicClient.getBlock(block),
      },
      target: input.anchorTarget,
      digest,
    }),
    waitForFinalized: (wait) => waitForFinalizedAnchor({
      anchorClient,
      digest: wait.digest,
      locator: wait.locator,
      timeoutMs: wait.timeoutMs,
      pollMs: wait.pollMs,
      ...(wait.onProgress === undefined ? {} : { onProgress: wait.onProgress }),
    }),
  };
}

/** `ceremony show`'s live anchor read: is this declared anchor finalized on chain right now? */
export async function readCeremonyAnchorStatus(input: {
  readonly digest: `sha256:${string}`;
  readonly locator: unknown;
  readonly rpcUrl?: string;
}): Promise<{ readonly finalized: boolean; readonly anchorTime?: string } | null> {
  const anchorClient = createBaseSepoliaFinalizedAnchorClient(
    createViemBaseSepoliaReadClients(publicClientFor(input.rpcUrl)).anchor,
  );
  const observed = await anchorClient.lookupFinalizedAnchor({
    digest: input.digest,
    locator: input.locator as Parameters<typeof anchorClient.lookupFinalizedAnchor>[0]['locator'],
  });
  return observed === null ? null : { finalized: observed.finalized, anchorTime: observed.anchorTime };
}

/** Re-exported so the ceremony CLI has one import surface for anchor declarations. */
export { anchorDeclaration };
