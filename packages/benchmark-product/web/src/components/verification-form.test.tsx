import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GuiActionState } from "@/lib/action-state";

const actionState = vi.hoisted(() => ({ current: { status: "idle" } as GuiActionState }));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useActionState: () => [actionState.current, vi.fn(), false],
}));

import { VerificationForm } from "./verification-form";

const action = vi.fn(async () => ({ status: "idle" as const }));

describe("verification action presentation", () => {
  beforeEach(() => { actionState.current = { status: "idle" }; });

  test("renders named checks and exact digests semantically after success", () => {
    actionState.current = {
      status: "success",
      result: {
        checks: ["matrix-rederivation", "report-verification", "claim-consistency"],
        matrixSha256: "a".repeat(64),
        reportEnvelopeSha256: "b".repeat(64),
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("Verification passed");
    expect(markup).toContain("matrix-rederivation");
    expect(markup).toContain("report-verification");
    expect(markup).toContain("claim-consistency");
    expect(markup).toContain("a".repeat(64));
    expect(markup).toContain("b".repeat(64));
    expect(markup).not.toContain("<pre");
  });

  test("renders per-anchor status and the pending-window warning", () => {
    actionState.current = {
      status: "success",
      result: {
        draftId: "draft-1",
        checks: ["matrix-rederivation", "integrity-anchors"],
        matrixSha256: "a".repeat(64),
        anchors: {
          anchors: [{
            recordSha256: "c".repeat(64),
            status: "pending",
            subject: "lock",
            trustMaterial: "none",
          }],
          subjects: [
            { subject: "lock", outcome: "anchored" },
            { subject: "matrix", outcome: "absent" },
          ],
          invalid: [],
        },
        anchoringWindow: { closingOperation: "report" },
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("lock · pending");
    expect(markup).toContain("lock: anchored");
    expect(markup).toContain("matrix: absent");
    expect(markup).toContain("unresolved pending anchor evidence exists and `report` closes the anchoring window.");
  });

  test("names declared anchor profiles without the unhosted origin", () => {
    actionState.current = {
      status: "success",
      result: {
        checks: ["integrity-anchors"],
        matrixSha256: "a".repeat(64),
        anchors: {
          anchors: [],
          subjects: [{
            subject: "lock",
            outcome: "anchored",
            declaredProfiles: ["https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1"],
          }],
          invalid: [],
        },
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("rfc3161-tsa/v1");
    expect(markup).not.toContain("spec.jinn.network");
    expect(markup).not.toContain("https://");
  });

  test("renders a typed recomputation or integrity failure loudly and never claims success", () => {
    actionState.current = {
      status: "error",
      error: {
        code: "record-integrity",
        detail: "matrix-rederivation: exact recompute divergence",
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Verification failed: record-integrity");
    expect(markup).toContain("exact recompute divergence");
    expect(markup).not.toContain("Verification passed");
  });
});
