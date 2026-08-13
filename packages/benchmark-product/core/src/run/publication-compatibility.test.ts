import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appendRunJournalEntry } from "./journal.js";
import { assessPublicationCompatibility } from "./publication-compatibility.js";
import { createPublicationState, writeRunState } from "./state.js";

let workspaceDir: string;
const HEX = (value: string) => value.repeat(64);
const CELL = `${HEX("a")}/arm-a/1`;

beforeEach(() => { workspaceDir = mkdtempSync(join(tmpdir(), "pub09-compat-")); });
afterEach(() => { rmSync(workspaceDir, { recursive: true, force: true }); });

function state(publication = undefined) {
  return { draftId: "draft-1", specSha256: HEX("a"), owner: "urn:uuid:00000000-0000-5000-8000-000000000001", ...(publication === undefined ? {} : { publication }) };
}

describe("assessPublicationCompatibility", () => {
  test("refuses a legacy local run without inventing historical attempts", () => {
    writeRunState(workspaceDir, "draft-1", state());
    expect(assessPublicationCompatibility(workspaceDir, "draft-1")).toEqual({
      status: "refused",
      reasons: ["legacy run state has no prospective publication capture"],
    });
  });

  test("accepts a managed run with complete prospective dispatch capture", () => {
    writeRunState(workspaceDir, "draft-1", state(createPublicationState()));
    appendRunJournalEntry(workspaceDir, "draft-1", { kind: "submission-captured", at: "2026-08-13T00:00:00Z", cellKey: CELL, armId: "arm-a", replicate: 1, dispatch: 1, submissionSha256: HEX("b") });
    appendRunJournalEntry(workspaceDir, "draft-1", { kind: "submission-accepted", at: "2026-08-13T00:00:01Z", cellKey: CELL, dispatch: 1, submissionSha256: HEX("b"), leg: "solve" });
    appendRunJournalEntry(workspaceDir, "draft-1", { kind: "observation-accepted", at: "2026-08-13T00:00:02Z", cellKey: CELL, armId: "arm-a", replicate: 1, dispatch: 1, submissionSha256: HEX("b"), observationArchiveSha256: HEX("c"), attempt: "urn:uuid:attempt-1" });
    expect(assessPublicationCompatibility(workspaceDir, "draft-1")).toEqual({ status: "ready", dispatchCount: 1 });
  });
});
