// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for `binaryAdmissionEvidenceRoleToAuthorityRole` (spec §6.8a Group B-bis; packet P6,
 * S3b item E): the exhaustive mapping `materializeBundle`'s authority-binding discriminator uses
 * to decide which product-authority role signed a reachable admission-closure record.
 *
 * The spec calls this discriminator's ORIGINAL shape (a hand-written or-chain over three string
 * literals followed by `if (role === undefined) continue;`) invisible to both the compiler and the
 * grep sweep: widening the evidence-role vocabulary does not make an or-chain fail to compile, and
 * the line carries none of the family's search tokens. This pure function is extracted from that
 * discriminator specifically so the exhaustive mapping itself — the actual new logic this packet
 * adds — has direct, fast unit coverage without needing the full Benchmark/Run/Matrix/Report
 * bundle-materialization fixture (`./testing/v4-synthetic-fixture.ts`, whose `truthAdmission`
 * option is a separate lane's scope, not widened here). The two existing evidence roles' mappings
 * and the full bundle-materialization path for `operator-only` and `two-human-unanimous` stay
 * covered by the existing `v4-materialize.test.ts` suite, unmodified.
 */

import { describe, expect, test } from "vitest";
import { binaryAdmissionEvidenceRoleToAuthorityRole } from "./materialize.js";

describe("binaryAdmissionEvidenceRoleToAuthorityRole (spec §6.8a Group B-bis)", () => {
  test("maps every evidence role to its exact authority role", () => {
    expect(binaryAdmissionEvidenceRoleToAuthorityRole("reviewer-roster")).toBe("roster-attestor");
    expect(binaryAdmissionEvidenceRoleToAuthorityRole("review-reveal-receipt")).toBe("truth-reveal-attestor");
    expect(binaryAdmissionEvidenceRoleToAuthorityRole("operator-assertion")).toBe("operator-truth-attestor");
    // Both new screened-branch roles map to the SAME authority role that the per-item reveal
    // receipt already uses (§6.6 reuses truth-reveal-attestor rather than minting a new role;
    // §6.8a Group C's frozen third authority set is exactly ["truth-reveal-attestor"]).
    expect(binaryAdmissionEvidenceRoleToAuthorityRole("screening-table")).toBe("truth-reveal-attestor");
    expect(binaryAdmissionEvidenceRoleToAuthorityRole("screening-reveal-receipt")).toBe("truth-reveal-attestor");
  });
});
