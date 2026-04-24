/**
 * Read-only aggregation helpers over ERC-8004 signals.
 *
 * Scope: §3.3 "Reputation Registry aggregates operator-level signals
 * (including emergent attestation-track-record: '% of envelopes from Safe X
 * that have been challenger-verified as attested'). Reputation is emergent,
 * not hand-written."
 *
 * V1 ships no Reputation Registry writes. This module provides the read
 * surface: it projects on-chain events (validation responses) + envelope
 * metadata into per-operator metrics.
 *
 * TODO(Plan G): Once the subgraph join is deployed, `queryOperatorValidations`
 * will return real data and the successfulVerifications / failedVerifications
 * counts will reflect actual Validation Registry events.
 */

import { queryEnvelopes, queryOperatorValidations } from '../discovery/subgraph.js';

export interface OperatorReputation {
  safeAddress: string;
  successfulVerifications: number;
  failedVerifications: number;
  attestedPercent: number;     // 0–100; % of envelopes with tier='attested'
  lastSignalBlock: number | null;  // latest block with a reputation-affecting event, null if none
}

export interface ReputationDeps {
  subgraphUrl: string;
}

export async function getOperatorReputation(
  safeAddress: string,
  deps: ReputationDeps,
): Promise<OperatorReputation> {
  const config = { url: deps.subgraphUrl };

  const [envelopes, validations] = await Promise.all([
    queryEnvelopes(config, { participant: safeAddress, limit: 1000 }),
    queryOperatorValidations(config, safeAddress),
  ]);

  const total = envelopes.length;
  const attestedCount = envelopes.filter((e) =>
    e.metadata.some((m) => m.key === 'evidenceTier' && m.value === 'attested'),
  ).length;
  const attestedPercent = total === 0 ? 0 : (attestedCount / total) * 100;

  const successfulVerifications = validations.filter((v) => v.verdict === 'valid').length;
  const failedVerifications = validations.filter((v) => v.verdict === 'invalid').length;
  const lastSignalBlockRaw = validations.reduce((max, v) => Math.max(max, v.blockNumber), 0);
  const lastSignalBlock = lastSignalBlockRaw === 0 ? null : lastSignalBlockRaw;

  return {
    safeAddress,
    successfulVerifications,
    failedVerifications,
    attestedPercent,
    lastSignalBlock,
  };
}
