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
