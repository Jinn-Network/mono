/**
 * Per-skill licence gate (plan Task 6, spec §7 / D8).
 *
 * The allowlist is bounded and disclosed: permissive licences import (with
 * attribution carried in the published envelope); anything else — including
 * a missing licence — skips with a stated reason. Copyleft is excluded not
 * as a legal judgement but as a posture: the corpus republishes content, and
 * share-alike terms make that a per-licence analysis we have not done.
 */

/** SPDX ids that import (with attribution). Bounded, disclosed. */
export const IMPORT_LICENCE_ALLOWLIST: readonly string[] = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
  'Unlicense',
  'MIT-0',
];

export interface LicenceVerdict {
  verdict: 'import' | 'skip';
  reason: string;
}

/** Map an SPDX id (or null = no licence found) to an import verdict. */
export function checkLicence(spdx: string | null | undefined): LicenceVerdict {
  if (!spdx || spdx === 'NOASSERTION') {
    return {
      verdict: 'skip',
      reason: 'no licence found — cannot republish without one',
    };
  }
  if (IMPORT_LICENCE_ALLOWLIST.includes(spdx)) {
    return { verdict: 'import', reason: `${spdx} — permissive, import with attribution` };
  }
  return {
    verdict: 'skip',
    reason: `${spdx} is not on the import allowlist (permissive licences only)`,
  };
}
