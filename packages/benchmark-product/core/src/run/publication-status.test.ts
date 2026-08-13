import { describe, expect, test } from "vitest";
import { projectPublicationStatus } from "./publication-status.js";
import { createPublicationState, type RunState } from "./state.js";

function state(): RunState {
  return { draftId: "draft-1", specSha256: "a".repeat(64), owner: "did:key:ztest", publication: createPublicationState() };
}

describe("publication status projection", () => {
  test("keeps local default, Run analysis commitment, and public timing distinct", () => {
    const value = projectPublicationStatus({ state: { ...state(), runSha256: "b".repeat(64) }, lifecycleState: "locked", compatibility: { status: "ready", dispatchCount: 0 } });
    expect(value).toMatchObject({ mode: "local", analysisPreregistration: "fixed-in-run", registrationTiming: "not-registered", postHocPublicationAvailable: false });
  });

  test("offers a closed managed compatible run post-hoc publication without claiming pre-dispatch timing", () => {
    const current = state();
    const value = projectPublicationStatus({ state: { ...current, runSha256: "b".repeat(64), closedAt: "2026-08-13T00:00:00Z" }, lifecycleState: "closed", compatibility: { status: "ready", dispatchCount: 3 } });
    expect(value).toMatchObject({ registrationTiming: "not-registered", postHocPublicationAvailable: true });
  });

  test("marks interrupted durable work resumable and retains only logical receipts/digests", () => {
    const current = state();
    current.publication = { ...current.publication!, accounting: { state: "in-progress", receipt: { sourceSequence: "0000000000000001", entrySha256: "c".repeat(64) }, digests: { accounting: "d".repeat(64) } } };
    const value = projectPublicationStatus({ state: current, lifecycleState: "closed", compatibility: { status: "refused", reasons: ["missing capture"] } });
    expect(value.recovery.resumable).toBe(true);
    expect(JSON.stringify(value)).not.toContain("workspace");
  });
});
