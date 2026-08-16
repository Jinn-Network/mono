import type { SolverNetManifestSummary } from '../../../../api/contract/index.js';

/**
 * ContractId of the canonical first-run demo SolverNet (SWE-rebench v2).
 * Both onboarding (SolverNetStep) and the post-onboarding Discover catalog
 * (RegistryCatalog) key off this so there is one source of truth. See #1240.
 */
export const DEMO_CONTRACT_ID = 'swe-rebench-v2';

/**
 * True for the launched canonical demo net — the row Discover hoists + badges
 * as the recommended first-run target. Matches on contractId (survives
 * re-launch: the CID rotates, contractId does not).
 */
export function isDemoSolverNet(s: SolverNetManifestSummary): boolean {
  return s.contractId === DEMO_CONTRACT_ID && s.status === 'launched';
}

/**
 * True for internal / smoke-test nets that must not appear in the operator
 * Discover list. There is no on-chain scope for these; launchers name them
 * ad hoc, and the only stable convention is a `smoke` substring in the net
 * name (case-insensitive). The canonical demo net is never treated as
 * internal even if some future name contained the substring.
 */
export function isInternalSolverNet(s: SolverNetManifestSummary): boolean {
  if (isDemoSolverNet(s)) return false;
  return /smoke/i.test(s.name ?? '');
}
