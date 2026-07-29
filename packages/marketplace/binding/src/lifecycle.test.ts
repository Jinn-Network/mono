import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA_TODAY } from "./addresses.js";
import { closeSubmission, releaseAttempt, signalCancel } from "./lifecycle.js";

describe("lifecycle exits", () => {
  test("today explicit close refunds budget then withdraws its announcement", async () => {
    const refundUnusedTaskBudget = vi.fn(async () => undefined);
    const withdrawAnnouncement = vi.fn(async () => undefined);
    await closeSubmission(4n, BASE_SEPOLIA_TODAY, { refundUnusedTaskBudget, withdrawAnnouncement });
    expect(refundUnusedTaskBudget).toHaveBeenCalledWith({ taskId: 4n });
    expect(withdrawAnnouncement).toHaveBeenCalledWith({ taskId: 4n });
  });

  test("revised seam uses closeTask and releaseAttempt, while today release is typed unsupported", async () => {
    const config = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
    const closeTask = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    await closeSubmission(4n, config, { closeTask, withdrawAnnouncement: async () => undefined });
    await releaseAttempt(4n, 2, config, { releaseAttempt: release });
    expect(closeTask).toHaveBeenCalledWith({ taskId: 4n });
    expect(release).toHaveBeenCalledWith({ taskId: 4n, attemptIndex: 2 });
    await expect(releaseAttempt(4n, 2, BASE_SEPOLIA_TODAY, {})).resolves.toEqual({ ok: false, kind: "unsupported" });
  });

  test("cancel is only a signal and never emits an on-chain revocation", async () => {
    const signal = vi.fn(async () => undefined);
    await signalCancel(4n, 2, { signal });
    expect(signal).toHaveBeenCalledWith({ taskId: 4n, attemptIndex: 2 });
  });
});
