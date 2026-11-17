/**
 * The workspace `verify` human output (issue #4940). `verify` re-derives three of the reader's
 * checks; `publish` runs the reader's whole list on the bundle it materializes. A reported run's
 * result therefore names the checks `verify` left to the reader, and the human output says so on a
 * second line, so a clean first line is never the whole story.
 */

import { describe, expect, test } from "vitest";
import type { RunVerifyResult } from "../operations/verify.js";
import { renderWorkspaceVerifyHuman } from "./verify-human.js";

const CLOSED: RunVerifyResult = {
  draftId: "draft-1",
  checks: ["matrix-rederivation"],
  matrixSha256: "a".repeat(64),
};

const REPORTED: RunVerifyResult = {
  draftId: "draft-1",
  checks: ["matrix-rederivation", "report-verification", "claim-consistency"],
  matrixSha256: "a".repeat(64),
  reportEnvelopeSha256: "b".repeat(64),
  readerChecksNotRun: ["manifest", "evidence-closure", "trust"],
};

describe("workspace verify human line", () => {
  test("a reported run keeps its first line and names the reader checks it did not run on the second", () => {
    const lines = renderWorkspaceVerifyHuman(REPORTED).split("\n");
    expect(lines[0]).toBe("verified draft draft-1: matrix-rederivation, report-verification, claim-consistency");
    expect(lines[1]).toBe(
      "not run here (publish runs them on the bundle and refuses if one fails): manifest, evidence-closure, trust",
    );
    expect(lines[2]).toBe("");
  });

  test("a closed run has no claim package, so it prints the one line and nothing about unrun checks", () => {
    expect(renderWorkspaceVerifyHuman(CLOSED)).toBe("verified draft draft-1: matrix-rederivation\n");
  });
});

/** Before `report`: two lock proofs, one still pending, and a promised matrix proof not carried. */
const TIMESTAMPED: RunVerifyResult = {
  draftId: "draft-1",
  checks: ["matrix-rederivation", "integrity-anchors"],
  matrixSha256: "a".repeat(64),
  anchors: {
    anchors: [{
      recordSha256: "c".repeat(64),
      status: "present",
      provider: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
      subject: "lock",
      timeBasis: "authority-time",
      trustMaterial: "none",
    }, {
      recordSha256: "d".repeat(64),
      status: "pending",
      provider: "https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1",
      subject: "lock",
      timeBasis: "chain-time",
      trustMaterial: "none",
    }],
    subjects: [
      { subject: "lock", outcome: "anchored" },
      {
        subject: "matrix",
        outcome: "declared-but-absent",
        declaredProfiles: ["https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1"],
      },
    ],
    invalid: [],
  },
  anchoringWindow: { closingOperation: "report" },
};

describe("workspace verify timestamp proofs (issue #5241)", () => {
  // Reader-facing vocabulary spec section 4.2, v1.14: the claimant reads this, then runs the reader
  // on the same records, so each outcome carries the reader's name. The values stay raw in `--json`.
  test("names each proof and outcome as the reader tool does", () => {
    expect(renderWorkspaceVerifyHuman(TIMESTAMPED)).toBe([
      "verified draft draft-1: matrix-rederivation, integrity-anchors",
      `lock timestamp proof: https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1, authority-time, present, record ${"c".repeat(64)}`,
      "  time source not evaluated: no trust anchors supplied",
      `lock timestamp proof: https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1, chain-time, pending, record ${"d".repeat(64)}`,
      "  no chain attestation yet",
      "Timestamp coverage",
      "  lock: timestamped",
      "  the runs: promised but missing — this run promised opentimestamps/v1 and the bundle carries no matching timestamp proof",
      "a timestamp proof is still pending, and `report` closes the anchoring window.",
      "",
    ].join("\n"));
  });

  test("an absent subject reads none, and no raw outcome value or retired word reaches the line", () => {
    const human = renderWorkspaceVerifyHuman({
      ...TIMESTAMPED,
      anchors: { anchors: [], subjects: [{ subject: "matrix", outcome: "absent" }], invalid: [] },
    });
    expect(human).toContain("  the runs: none — no timestamp proof was carried and none was promised");
    for (const retired of [/\banchored\b/u, /\babsent\b/u, /declared-but-absent/u, /Anchor subjects/u, /time basis/u, /trust material/u, /anchor evidence/u]) {
      expect(human).not.toMatch(retired);
    }
  });

  // Spec section 4.2, v1.15 (issue #5278): the record labeled `matrix` is the runs on every human
  // line, the per-proof line included; `--json` keeps the raw subject.
  test("names the matrix proof's record the runs, as the reader does", () => {
    const human = renderWorkspaceVerifyHuman({
      ...TIMESTAMPED,
      anchors: {
        anchors: [{
          recordSha256: "e".repeat(64),
          status: "pending",
          provider: "https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1",
          subject: "matrix",
          timeBasis: "chain-time",
          trustMaterial: "none",
        }],
        subjects: [{ subject: "lock", outcome: "absent" }, { subject: "matrix", outcome: "anchored" }],
        invalid: [],
      },
    });
    expect(human).toContain(
      `the runs timestamp proof: https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1, chain-time, pending, record ${"e".repeat(64)}`,
    );
    expect(human).toContain("Timestamp coverage\n  lock: none — no timestamp proof was carried and none was promised\n  the runs: timestamped");
    expect(human).not.toMatch(/^ *matrix\b/mu);
  });
});
