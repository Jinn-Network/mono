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

  test("offers post-hoc publication for a migrated closed run with no legacy publication field", () => {
    const current = state();
    delete current.publication;
    const value = projectPublicationStatus({ state: current, lifecycleState: "closed", compatibility: { status: "ready", dispatchCount: 3 } });
    expect(value).toMatchObject({ mode: "local", registrationTiming: "not-registered", postHocPublicationAvailable: true });
  });

  test("marks interrupted durable work resumable and retains only logical receipts/digests", () => {
    const current = state();
    current.publication = { ...current.publication!, accounting: { state: "in-progress", receipt: { sourceSequence: "0000000000000001", entrySha256: "c".repeat(64) }, digests: { accounting: "d".repeat(64) } } };
    const value = projectPublicationStatus({ state: current, lifecycleState: "closed", compatibility: { status: "refused", reasons: ["missing capture"] } });
    expect(value.recovery.resumable).toBe(true);
    expect(JSON.stringify(value)).not.toContain("workspace");
  });

  test("does not claim pre-dispatch timing while registration exact-byte verification is in progress", () => {
    const current = state();
    current.publication = { ...current.publication!, mode: "prospective", registration: { state: "in-progress", announcedAt: "2026-08-13T00:00:00Z", postHoc: false } };
    const value = projectPublicationStatus({ state: current, lifecycleState: "locked", compatibility: { status: "ready", dispatchCount: 0 } });
    expect(value.registrationTiming).toBe("pending-verification");
    expect(value.recovery.resumable).toBe(true);
  });

  test("treats complete registration without its durable receipt as unverified and resumable", () => {
    const current = state();
    current.publication = { ...current.publication!, mode: "prospective", registration: { state: "complete", postHoc: false, digests: { run: "e".repeat(64) } } };
    const value = projectPublicationStatus({ state: current, lifecycleState: "locked", compatibility: { status: "ready", dispatchCount: 0 } });
    expect(value.registrationTiming).toBe("pending-verification");
    expect(value.recovery.resumable).toBe(true);
    expect(value.stages[0]?.digests).toEqual({ run: "e".repeat(64) });
    expect(value.recovery.guidance).toMatch(/without its durable receipt/);
  });

  test("reports accounting-complete state truthfully rather than saying it remains local", () => {
    const current = state();
    current.publication = { ...current.publication!, registration: { state: "complete", postHoc: true, receipt: { sourceSequence: "0001", entrySha256: "e".repeat(64) } }, accounting: { state: "complete", receipt: { sourceSequence: "0002", entrySha256: "f".repeat(64) } }, matrixV2: { state: "complete", receipt: { sourceSequence: "0003", entrySha256: "a".repeat(64) } } };
    const value = projectPublicationStatus({ state: current, lifecycleState: "closed", compatibility: { status: "ready", dispatchCount: 1 } });
    expect(value.recovery.guidance).toMatch(/Accounting and Matrix publication are complete/);
    expect(value.recovery.guidance).not.toMatch(/remains local/);
  });

  test("projects Report v2 payload and envelope identities only with its durable receipt", () => {
    const current = state();
    current.publication = { ...current.publication!, report: { state: "complete", digests: { payload: "a".repeat(64), record: "b".repeat(64) } } };
    const unreceipted = projectPublicationStatus({ state: current, lifecycleState: "closed", compatibility: { status: "ready", dispatchCount: 1 } });
    expect(unreceipted.stages[3]).toMatchObject({ name: "report", state: "complete", digests: { payload: "a".repeat(64), record: "b".repeat(64) } });
    expect(unreceipted.recovery).toMatchObject({ resumable: true });

    current.publication = { ...current.publication!, report: { state: "in-progress", digests: { payload: "a".repeat(64), record: "b".repeat(64) } } };
    const interrupted = projectPublicationStatus({ state: current, lifecycleState: "closed", compatibility: { status: "ready", dispatchCount: 1 } });
    expect(interrupted.recovery).toMatchObject({ resumable: true });
    expect(interrupted.recovery.guidance).toMatch(/interrupted/);
  });
});
