import type { JinnConfig } from '../config.js';
import { resolveCredentialId, type CredentialId } from './credential.js';

export interface SpendCapDaemonConfig {
  /** credentialId -> USD/day cap. */
  caps: Record<CredentialId, number>;
  /** manifest CID -> the credential its harness bills against. */
  manifestCredentials: Record<string, CredentialId>;
}

/**
 * Assemble the daemon's spend-cap config from operator config + env. Returns
 * undefined when no credential ends up with a cap (the gate then stays off).
 */
export function buildSpendCapConfig(
  config: Pick<JinnConfig, 'joinedSolverNets' | 'spendCaps'>,
  env: NodeJS.ProcessEnv,
): SpendCapDaemonConfig | undefined {
  const blanketRaw = env['JINN_SPEND_CAP_USD'];
  const blanketNum = blanketRaw != null && blanketRaw.trim() !== '' ? Number(blanketRaw) : NaN;
  const blanket = Number.isFinite(blanketNum) && blanketNum > 0 ? blanketNum : undefined;

  const manifestCredentials: Record<string, CredentialId> = {};
  for (const [manifestCid, entry] of Object.entries(config.joinedSolverNets ?? {})) {
    const credentialId = resolveCredentialId(entry.harness, env);
    if (credentialId) manifestCredentials[manifestCid] = credentialId;
  }

  const caps: Record<CredentialId, number> = {};
  for (const credentialId of new Set(Object.values(manifestCredentials))) {
    const cap = config.spendCaps?.[credentialId] ?? blanket;
    if (cap != null) caps[credentialId] = cap;
  }

  return Object.keys(caps).length > 0 ? { caps, manifestCredentials } : undefined;
}
