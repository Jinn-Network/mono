import { resolveCliPassword } from '../src/cli/password.js';
import {
  decryptMnemonic,
  deriveAgentAddress,
  walletPrivateKeyAtIndex,
} from '../src/earning/wallet.js';
import {
  DEFAULT_EARNING_DIR,
  FleetStateStore,
  mnemonicKeystorePath,
} from '../src/earning/store.js';
import { isOperationalServiceStep } from '../src/earning/types.js';

export interface OperatorIdentity {
  privateKey: `0x${string}`;
  safeAddress: `0x${string}`;
  agentId: bigint;
  agentAddress: string;
  serviceIndex: number;
}

export interface DeriveOperatorIdentityOptions {
  earningDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the bootstrapped operator identity used by client-owned layer
 * publication entrypoints. This is intentionally kept out of the standalone
 * layer package: wallet access and publication authorization belong to the
 * host client.
 */
export async function deriveOperatorIdentity(
  argv: readonly string[],
  options: DeriveOperatorIdentityOptions = {},
): Promise<OperatorIdentity> {
  const env = options.env ?? process.env;
  const earningDir =
    options.earningDir ?? env['JINN_EARNING_DIR'] ?? DEFAULT_EARNING_DIR;
  const store = new FleetStateStore(earningDir);

  if (!store.hasMnemonicKeystore()) {
    throw new Error(
      `no keystore at ${mnemonicKeystorePath(earningDir)} — run \`jinn run\` to bootstrap first`,
    );
  }

  const password = resolveCliPassword(Array.from(argv), env);
  if (!password.ok) {
    throw new Error(password.message);
  }

  const state = await store.tryLoadExisting();
  const service = state?.services.find((candidate) =>
    isOperationalServiceStep(candidate.step),
  );
  if (!service?.safe_address || !service.agent_id) {
    throw new Error(
      'no fully-bootstrapped agent identity found (Safe/agent not yet registered) — finish `jinn run` bootstrap',
    );
  }

  let mnemonic: string;
  try {
    mnemonic = await decryptMnemonic(
      await store.loadMnemonicKeystore(),
      password.password,
    );
  } catch {
    throw new Error('could not decrypt keystore (wrong password?)');
  }

  const derivedAgentAddress = deriveAgentAddress(mnemonic, service.index);
  if (
    derivedAgentAddress.toLowerCase() !== service.agent_address.toLowerCase()
  ) {
    throw new Error(
      `derived wallet ${derivedAgentAddress} does not match stored agent address ${service.agent_address}; refusing to publish`,
    );
  }

  return {
    privateKey: walletPrivateKeyAtIndex(mnemonic, service.index),
    safeAddress: service.safe_address as `0x${string}`,
    agentId: BigInt(service.agent_id),
    agentAddress: derivedAgentAddress,
    serviceIndex: service.index,
  };
}
