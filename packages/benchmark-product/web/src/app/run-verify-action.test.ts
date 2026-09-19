import type { RunVerifyResult } from "@colophon-claims/core";
import { describe, expect, test, vi } from "vitest";

const runVerifyMock = vi.hoisted(() => vi.fn());

vi.mock("@colophon-claims/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@colophon-claims/core")>()),
  runVerify: runVerifyMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/server/product-context", () => ({
  createProductOperationContext: () => ({
    workspaceDir: "/tmp/colophon-web-verify",
    principal: "sponsor-1",
    clock: () => "2026-08-05T00:00:00.000Z",
  }),
  ProductContextConfigurationError: class extends Error {},
}));

const { runVerifyAction } = await import("@/app/actions");

const DIGEST = "a".repeat(64);

/**
 * Every key of `RunVerifyResult`. Adding a field to the type without naming it
 * here fails to compile, so the next GUI whitelist cannot drop it silently.
 */
const RUN_VERIFY_RESULT_KEYS = [
  "draftId",
  "checks",
  "matrixSha256",
  "anchors",
  "anchoringWindow",
  "reportEnvelopeSha256",
  "additionalReports",
  "runtimeMethod",
] as const satisfies readonly (keyof RunVerifyResult)[];

type MissingRunVerifyKeys = Exclude<keyof RunVerifyResult, typeof RUN_VERIFY_RESULT_KEYS[number]>;
type ExtraRunVerifyKeys = Exclude<typeof RUN_VERIFY_RESULT_KEYS[number], keyof RunVerifyResult>;
const _runVerifyKeysAreExhaustive: [MissingRunVerifyKeys] extends [never]
  ? [ExtraRunVerifyKeys] extends [never] ? true : never
  : never = true;
void _runVerifyKeysAreExhaustive;

describe("run.verify GUI/CLI field equivalence", () => {
  test("the action returns the operation result unchanged", async () => {
    const result: RunVerifyResult = {
      draftId: "draft-1",
      checks: ["matrix-rederivation", "integrity-anchors"],
      matrixSha256: DIGEST,
      anchors: {
        anchors: [],
        subjects: [{
          subject: "lock",
          outcome: "declared-but-absent",
          declaredProfiles: ["https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1"],
        }],
        invalid: [],
      },
      anchoringWindow: { closingOperation: "report" },
    };
    runVerifyMock.mockResolvedValue({ ok: true, result });
    const data = new FormData();
    data.set("draftId", "draft-1");
    const state = await runVerifyAction({ status: "idle" }, data);
    expect(state).toEqual({ status: "success", result });
    expect(state.status === "success" ? Object.keys(state.result as object).sort() : []).toEqual(
      Object.keys(result).sort(),
    );
  });
});
