/**
 * Fixture: a known-solvable SWE-rebench v2 instance, shared by T2.4 and T3.1.
 *
 * Selection criteria:
 *   - Currently admitted to the SWE-rebench v2 pool (verdict-time recheck won't reject it).
 *   - Small repo, fast clone.
 *   - Has a known-good solution patch that produces `verdictCode=1` against the
 *     evaluator's Docker image at the digest pinned in operator/src/eval/admission.
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
 * mainline SolverNet on Base Sepolia). For cross-checks against the SolverNet's
 * manifest at runtime. T2.2 (fork) keeps using this — the fork is isolated
 * from real-network griefers by virtue of being on a private Anvil fork.
 */
export const KNOWN_MANIFEST_CID =
  'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi';

/**
 * Manifest CID for the **isolated** SWE-rebench v2 SolverNet used by T3.1 on
 * real Base Sepolia.
 *
 * Why this exists
 * ---------------
 * The live SWE-rebench v2 mainline is shared with an external griefer
 * (`0x26e96ba6dCbB86C1d18553b3F3D3202f3A3E0638`) that grabs solve / verdict
 * slots within ~2 blocks of each task creation and squats them. T3.1 could
 * only green when the controlled substrate operator won a race against its
 * own pipeline latency — that happened by luck on task 191 (6m18s) but
 * starved on task 207 when op-a's codex lane was busy.
 *
 * The fix is structural, not tuning: this SolverNet is a separate launched
 * instance the griefer is not joined to. Per spec §12 / CLAUDE.md, claim
 * eligibility filters on `joinedSolverNets[<manifestCid>]`, so the griefer
 * cannot claim from a manifestCid they have not opted into. With them
 * absent, the controlled producer/evaluator pair closes the loop
 * deterministically.
 *
 * Provenance
 * ----------
 *   - Launcher: op-a (agentId 5474, master Safe
 *     0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC)
 *   - Anchor tx: `0x3d9c7a0c9bfae5bbcd623a6bd8bdf48dcc3b0aac86d2c7cc4e29dbbe0de553e3`
 *     (`IdentityRegistry.setMetadata`, key `solvernet-manifest:<this cid>`)
 *   - Anchor block: 41861303 on Base Sepolia (chainId 84532)
 *   - Same SolverNet contract as the mainline (`swe-rebench-v2.v1`), same
 *     evaluator implementation, same task/solution/verdict schemas — so the
 *     KNOWN_INSTANCE_ID fixture and KNOWN_EXPECTED_VERDICT above remain
 *     applicable.
 *   - The launcher's generator is intentionally disabled
 *     (`generatorEnabled: false` on the local launched record) so the
 *     SolverNet only carries tasks T3.1 posts explicitly — no background
 *     auto-generator competing for op-a/op-b's solver capacity during the
 *     release-readiness gate.
 *
 * If this SolverNet needs to be re-launched (e.g. the launcher's master
 * Safe rotates, or the manifest schema changes), regenerate via
 * `operator/scripts/release/launch-isolated-solvernet.ts` and update this
 * constant + the anchor tx hash above.
 */
export const KNOWN_T31_ISOLATED_MANIFEST_CID =
  'bafkreievikw3uuruzobvyolriewqv5jgo767lylco2h3x2oqk2bdwqobda';

/**
 * Solution envelope CID from the v0.1.6 verification (provenance).
 * Retrieved from: https://gateway.autonolas.tech/ipfs/<cid>
 */
export const KNOWN_SOLUTION_ENVELOPE_CID =
  'bafkreiblwwfl2dmsat3pljjzay5pplhyyqxmgorqgnj7gdhgcglcp77ywm';
