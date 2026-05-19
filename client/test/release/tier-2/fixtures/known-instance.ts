/**
 * Fixture: a known-solvable SWE-rebench v2 instance for T2.2.
 *
 * Selection criteria:
 *   - Currently admitted to the SWE-rebench v2 pool (verdict-time recheck won't reject it).
 *   - Small repo, fast clone.
 *   - Has a known-good solution patch that produces `verdictCode=1` against the
 *     evaluator's Docker image at the digest pinned in client/src/eval/admission.
 *
 * Provenance: the v0.1.6 stewardship gate (`log/decisions/2026-05-19-v0.1.6-stewardship.md`)
 * verified this instance with verdictCode=1; the solution envelope CID
 * (`bafkreiblwwfl2dmsat3pljjzay5pplhyyqxmgorqgnj7gdhgcglcp77ywm`) holds the patch
 * and trajectory. The sympy/sympy commit hash was cross-checked against the
 * nebius/SWE-rebench-leaderboard HuggingFace dataset (split 2025_01) and confirmed
 * as `f07466ae38d6f7985c4e9eec2c7dfff43fec3cf7`.
 *
 * The patch saved in `sympy__sympy-27510.patch` is the AGENT-AUTHORED patch from the
 * solution envelope (modifying sympy/printing/str.py), which is distinct from the
 * dataset's gold patch (modifying sympy/printing/precedence.py). Both achieve
 * verdictCode=1. The patch here is the one Op B actually submitted and Op A verified.
 *
 * If the SWE-rebench pool rebuild invalidates this instance, replace it with
 * another admitted instance + its patch. See `<instance-id>.patch` next to this file.
 */

export const KNOWN_INSTANCE_ID = 'sympy__sympy-27510';
export const KNOWN_REPO = 'sympy/sympy';

/**
 * Base commit hash for the sympy/sympy SWE-rebench instance.
 * Source: nebius/SWE-rebench-leaderboard HuggingFace dataset, split 2025_01,
 * field `base_commit`.
 */
export const KNOWN_COMMIT = 'f07466ae38d6f7985c4e9eec2c7dfff43fec3cf7';

export const KNOWN_EXPECTED_VERDICT = 1; // 1 = passed; 0 = failed

export const KNOWN_PATCH_FILE = `${KNOWN_INSTANCE_ID}.patch`;

/**
 * Manifest CID under which this instance was admitted (the SWE-rebench v2
 * SolverNet on Base Sepolia). For cross-checks against the SolverNet's
 * manifest at runtime.
 */
export const KNOWN_MANIFEST_CID =
  'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi';

/**
 * Solution envelope CID from the v0.1.6 verification (provenance).
 * Retrieved from: https://gateway.autonolas.tech/ipfs/<cid>
 */
export const KNOWN_SOLUTION_ENVELOPE_CID =
  'bafkreiblwwfl2dmsat3pljjzay5pplhyyqxmgorqgnj7gdhgcglcp77ywm';
