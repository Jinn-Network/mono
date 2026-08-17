/**
 * Claim-policy write intent (headless §4.1 / §10).
 *
 * Both `PUT /v1/operator/claim-policy` and `jinn policy set` converge here.
 * Restart-required: claim policy is not hot-applied.
 */
import { persistTopLevelConfigValue } from '../config.js';
import type { ClaimPolicyConfig } from '../config/shape-v2.js';

export interface WriteClaimPolicyInput {
  readonly claimPolicy: ClaimPolicyConfig;
  readonly configPath?: string;
  readonly persist?: typeof persistTopLevelConfigValue;
  readonly notifyRestartRequired?: () => void;
}

export interface WriteClaimPolicyResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verb: 'policy set';
  readonly restartRequired: true;
  readonly claimPolicy: ClaimPolicyConfig;
}

export function writeClaimPolicyIntent(input: WriteClaimPolicyInput): WriteClaimPolicyResult {
  const persist = input.persist ?? persistTopLevelConfigValue;
  persist('claimPolicy', input.claimPolicy, input.configPath);
  input.notifyRestartRequired?.();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'policy set',
    restartRequired: true,
    claimPolicy: input.claimPolicy,
  };
}
