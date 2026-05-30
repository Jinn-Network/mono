import {
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  HERMES_AGENT_HARNESS,
} from '../harnesses/names.js';
import { resolveCredentialId, type CredentialId } from './credential.js';

const COST_SURFACE_HARNESSES = [
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  HERMES_AGENT_HARNESS,
] as const;

export interface CostSurfaceHarnessStatus {
  credentialId: CredentialId | null;
  usesPaidApiKey: boolean;
}

export interface CostSurfaceStatus {
  harnesses: Record<string, CostSurfaceHarnessStatus>;
}

export function credentialUsesPaidApiKey(credentialId: CredentialId | null): boolean {
  return credentialId !== null && credentialId.endsWith(':api-key');
}

export function buildCostSurfaceStatus(
  env: NodeJS.ProcessEnv,
  /** Optional home dir override for the disk-OAuth probe — tests only. */
  homeDirOverride?: string,
): CostSurfaceStatus {
  const harnesses: Record<string, CostSurfaceHarnessStatus> = {};
  for (const harness of COST_SURFACE_HARNESSES) {
    const credentialId = resolveCredentialId(harness, env, homeDirOverride);
    harnesses[harness] = {
      credentialId,
      usesPaidApiKey: credentialUsesPaidApiKey(credentialId),
    };
  }
  return { harnesses };
}
