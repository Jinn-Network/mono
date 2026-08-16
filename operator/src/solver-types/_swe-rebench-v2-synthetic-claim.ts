/**
 * Synthetic task claim eligibility — minter≠solver, sourceSolver≠solver (§7).
 */

export interface SyntheticTaskProvenance {
  synthetic?: boolean;
  minterSafe?: string;
  sourceSolverSafe?: string;
}

export function syntheticClaimBlocked(
  provenance: SyntheticTaskProvenance | undefined,
  operatorSafe: string,
): string | null {
  if (!provenance?.synthetic) return null;
  const op = operatorSafe.toLowerCase();
  if (provenance.minterSafe && provenance.minterSafe.toLowerCase() === op) {
    return 'synthetic task: minter cannot claim own mint';
  }
  if (provenance.sourceSolverSafe && provenance.sourceSolverSafe.toLowerCase() === op) {
    return 'synthetic task: source solver cannot claim echo';
  }
  return null;
}
