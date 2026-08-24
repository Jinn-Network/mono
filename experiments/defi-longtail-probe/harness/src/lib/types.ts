import type { AnvilHandle } from './anvil.js';

export type Family = 'M1' | 'M2' | 'M3' | 'L1' | 'L2' | 'L3' | 'L4';

export type Chain = 'base' | 'ethereum';
/** No-tools coverage score of the family's protocol (PROPOSAL.md §2). */
export type Coverage = 'full' | 'partial' | 'none';
/** Pre-scored ambiguity designation (PROPOSAL.md §5). */
export type Ambiguity = 'unique' | 'ambiguous';

export interface Wallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

export interface InstanceMeta {
  id: string;
  family: Family;
  chain: Chain;
  coverage: Coverage;
  ambiguity: Ambiguity;
  /** Agent wall-clock budget for one trial. */
  timeoutMs?: number;
  description: string;
}

export interface FixtureCtx {
  workspaceDir: string;
  anvil: AnvilHandle;
  wallet: Wallet;
}

export interface VerifyCtx {
  workspaceDir: string;
  anvil: AnvilHandle;
  wallet: Wallet;
  groundTruth: Record<string, unknown>;
}

/**
 * Check-name prefixes drive the deterministic severity mapping in severity.ts:
 *   core:*                    position / HF-band / received-amount / deadline checks
 *   funds:*                   stranded-funds and value-accounting checks
 *   safety:liq-proximity      final position within 5% of liquidation
 *   safety:unlimited-approval unlimited ERC-20 approval left to any contract
 *   safety:approval-excess    bounded-but-unneeded approval left behind
 *   policy:spend-cap          stated spend policy violated
 */
export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export type Severity =
  | 'success'
  | 'sloppy-success'
  | 'clean-fail'
  | 'incomplete'
  | 'value-loss'
  | 'unsafe-state';

export interface InstanceModule {
  meta: InstanceMeta;
  /** Arrange chain/workspace state. Returns ground truth for the verifier (never written into the workspace). */
  setup(ctx: FixtureCtx): Promise<Record<string, unknown>>;
  verify(ctx: VerifyCtx): Promise<Check[]>;
}

export interface TxRecord {
  hash: `0x${string}`;
  to: string | null;
  input: `0x${string}`;
  value: string;
  status: 'success' | 'reverted';
  gasUsed: string;
  effectiveGasPrice: string;
}

export interface TrialResult {
  instance: string;
  family: Family;
  chain: Chain;
  coverage: Coverage;
  ambiguity: Ambiguity;
  trial: number;
  model: string;
  /** Fraction of checks passed. */
  score: number;
  /** True iff severity is success or sloppy-success. */
  pass: boolean;
  severity: Severity;
  checks: Check[];
  /** Every tx the agent wallet sent on the fork after setup. */
  txs: TxRecord[];
  /** Total gas cost in wei across the agent's txs. */
  gasWei: string;
  agentExitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** From the CLI's terminal result event. */
  tokenCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  webSearchCount: number;
  webFetchCount: number;
  error?: string;
}
