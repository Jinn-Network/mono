import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const loadRunViewMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/view-models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/view-models")>(),
  loadRunView: loadRunViewMock,
}));
vi.mock("@/lib/server/gui-action-registry", () => ({
  GUI_SERVER_ACTIONS: {
    "run.launch": vi.fn(),
    "run.resume": vi.fn(),
    "run.cancel": vi.fn(),
    "run.collect": vi.fn(),
    "run.anchor": vi.fn(),
    "publication.configure": vi.fn(),
    "publication.register": vi.fn(),
    "publication.accounting": vi.fn(),
    "publication.report": vi.fn(),
  },
}));
vi.mock("@/components/action-form", () => ({
  ActionForm: ({ submitLabel, children, disabled }: { readonly submitLabel: string; readonly children?: ReactNode; readonly disabled?: boolean }) => <form><button disabled={disabled}>{submitLabel}</button>{children}</form>,
}));
vi.mock("@/components/run-monitor-refresh", () => ({ RunMonitorRefresh: () => <button>Refresh</button> }));

import RunMonitorPage from "./page";
import { projectRunStatusForGui } from "@/lib/server/view-models";

function status(state: "running" | "closed" | "reported" | "published-bundle", cancelRequested: boolean) {
  return {
    ok: true as const,
    draft: { ok: true as const, result: {} },
    status: {
      ok: true as const,
      result: {
        state,
        cancelRequested,
        cells: [],
        counts: { expected: 6, dispatched: 6, delivered: 0, judged: 0, failed: 6, awaitingEvaluation: 0 },
      },
    },
    publication: { ok: true as const, result: {
      mode: "local", analysisPreregistration: "fixed-in-run", registrationTiming: "not-registered",
      stages: [{ name: "registration", state: "not-started", digests: {} }, { name: "accounting", state: "not-started", digests: {} }, { name: "matrix", state: "not-started", digests: {} }, { name: "report", state: "not-started", digests: {} }],
      compatibility: { status: "ready", dispatchCount: 0 }, postHocPublicationAvailable: ["closed", "reported", "published-bundle"].includes(state),
      recovery: { resumable: false, guidance: "Publication remains local until you explicitly configure and register a public source." },
    } },
    publicationConfiguration: { available: true, publicBaseUrl: "https://public.example/publication" },
  };
}

describe("durable run monitor cancellation language", () => {
  beforeEach(() => loadRunViewMock.mockReset());

  test("calls a running cancellation requested and draining", async () => {
    loadRunViewMock.mockReturnValue(status("running", true));
    const markup = renderToStaticMarkup(await RunMonitorPage({
      params: Promise.resolve({ draftId: "draft-1" }),
    }));
    expect(markup).toContain("Cancellation requested; driver is draining.");
    expect(markup).not.toContain("Cancellation finalized; run is cancelled.");
    expect(markup).toContain("Provider network and possible charges.");
    expect(markup).toContain("The bundled sample needs no account, API key, funds, or provider connection.");
  });

  test("calls a closed run with a valid marker finalized and cancelled", async () => {
    loadRunViewMock.mockReturnValue(status("closed", true));
    const markup = renderToStaticMarkup(await RunMonitorPage({
      params: Promise.resolve({ draftId: "draft-1" }),
    }));
    expect(markup).toContain("Cancellation finalized; run is cancelled.");
    expect(markup).not.toContain("Cancellation requested; driver is draining.");
  });

  test("renders one anchor control per subject, gated on the run's own state and free of endpoints", async () => {
    loadRunViewMock.mockReturnValue(status("running", false));
    const running = renderToStaticMarkup(await RunMonitorPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
    expect(running).toContain("Anchor the sealed Run record");
    expect(running).toContain("Anchor the terminal Matrix");
    expect(running).toContain('name="subject" value="lock"');
    expect(running).toContain('name="subject" value="matrix"');
    // A lock anchor must precede dispatch, so a running draft cannot obtain one; the Matrix is not
    // sealed yet either.
    expect(running).toContain('<button disabled="">Anchor the sealed Run record');
    expect(running).toContain('<button disabled="">Anchor the terminal Matrix');
    expect(running).not.toContain('name="endpoint"');
    expect(running).not.toContain('name="provider"');

    loadRunViewMock.mockReturnValue(status("closed", false));
    const closed = renderToStaticMarkup(await RunMonitorPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
    expect(closed).not.toContain('<button disabled="">Anchor the terminal Matrix');
    // The lock window shut at launch, so the lock control stays disabled here.
    expect(closed).toContain('<button disabled="">Anchor the sealed Run record');

    // The anchoring window closes at `report` (§19.5): past it the operation always refuses, so
    // offering the control would be an enabled button whose only outcome is a refusal.
    for (const past of ["reported", "published-bundle"] as const) {
      loadRunViewMock.mockReturnValue(status(past, true));
      const afterReport = renderToStaticMarkup(await RunMonitorPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
      expect(afterReport).toContain('<button disabled="">Anchor the terminal Matrix');
      expect(afterReport).toContain('<button disabled="">Anchor the sealed Run record');
    }
  });

  test("keeps local-first default while offering post-hoc accounting without a Report", async () => {
    loadRunViewMock.mockReturnValue(status("closed", true));
    const markup = renderToStaticMarkup(await RunMonitorPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
    expect(markup).toContain("Local-first (not public by default)");
    expect(markup).toContain("Configure post-hoc public source (does not rerun)");
    expect(markup).toContain("Register post-hoc (does not rerun)");
    expect(markup).toContain("Publish accounting and Matrix (does not rerun)");
    expect(markup).toContain("Publish signed Report v2 (does not rerun)");
    expect(markup).toContain('name="consent" value="publish-signed-report-v2"');
    expect(markup).toContain("does not require a Report");
    expect(markup).toContain("https://public.example/publication");
    expect(markup).not.toContain('name="publicBaseUrl"');
  });

  test.each(["reported", "published-bundle"] as const)("keeps post-hoc no-rerun controls available from %s", async (state) => {
    loadRunViewMock.mockReturnValue(status(state, false));
    const markup = renderToStaticMarkup(await RunMonitorPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
    expect(markup).toContain("Configure post-hoc public source (does not rerun)");
    expect(markup).toContain("Register post-hoc (does not rerun)");
    expect(markup).toContain("Publish accounting and Matrix (does not rerun)");
    expect(markup).toContain("Publish signed Report v2 (does not rerun)");
    expect(markup).not.toContain("<button disabled=\"\">Configure post-hoc");
    expect(markup).not.toContain("<button disabled=\"\">Register post-hoc");
    expect(markup).not.toContain("<button disabled=\"\">Publish accounting");
    expect(markup).toContain("<button disabled=\"\">Publish signed Report v2");
  });

  test("does not enable signed Report v2 over complete-but-unreceipted accounting stages", async () => {
    const value = status("closed", false);
    value.publication.result.stages[1] = { name: "accounting", state: "complete", digests: { accounting: "a".repeat(64) } };
    value.publication.result.stages[2] = { name: "matrix", state: "complete", digests: { matrixV2: "b".repeat(64) } };
    loadRunViewMock.mockReturnValue(value);
    const markup = renderToStaticMarkup(await RunMonitorPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
    expect(markup).toContain("<button disabled=\"\">Publish signed Report v2");
  });

  test("keeps a complete-but-unreceipted or identity-incomplete Report retryable", async () => {
    const value = status("closed", false);
    value.publication.result.stages[1] = { name: "accounting", state: "complete", receipt: { sourceSequence: "0002", entrySha256: "a".repeat(64) }, digests: { accounting: "b".repeat(64) } } as never;
    value.publication.result.stages[2] = { name: "matrix", state: "complete", receipt: { sourceSequence: "0003", entrySha256: "c".repeat(64) }, digests: { matrixV2: "d".repeat(64) } } as never;
    value.publication.result.stages[3] = { name: "report", state: "complete", digests: { payload: "e".repeat(64) } } as never;
    loadRunViewMock.mockReturnValue(value);
    const markup = renderToStaticMarkup(await RunMonitorPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
    expect(markup).toContain("Retry / resume signed Report v2");
    expect(markup).not.toContain("Signed Report v2 published");
    expect(markup).not.toContain("<button disabled=\"\">Retry / resume signed Report v2");
  });

  test("calls a Report published only when its receipt and both v2 identities are durable", async () => {
    const value = status("closed", false);
    value.publication.result.stages[1] = { name: "accounting", state: "complete", receipt: { sourceSequence: "0002", entrySha256: "a".repeat(64) }, digests: { accounting: "b".repeat(64) } } as never;
    value.publication.result.stages[2] = { name: "matrix", state: "complete", receipt: { sourceSequence: "0003", entrySha256: "c".repeat(64) }, digests: { matrixV2: "d".repeat(64) } } as never;
    value.publication.result.stages[3] = { name: "report", state: "complete", receipt: { sourceSequence: "0004", entrySha256: "e".repeat(64) }, digests: { payload: "f".repeat(64), record: "0".repeat(64) } } as never;
    loadRunViewMock.mockReturnValue(value);
    const markup = renderToStaticMarkup(await RunMonitorPage({ params: Promise.resolve({ draftId: "draft-1" }) }));
    expect(markup).toContain("<button disabled=\"\">Signed Report v2 published");
  });

  test("renders a typed durable failure without serializing its sensitive detail", async () => {
    const sentinel = "/private/workspace/report-signing-key-VERY_SECRET.pem";
    const projected = projectRunStatusForGui({
      state: "running",
      cancelRequested: false,
      driver: {
        operation: "launch",
        generation: "generation-1",
        startedAt: "2026-08-07T00:00:00.000Z",
        completedAt: "2026-08-07T00:00:01.000Z",
        status: "failed",
        error: { code: "execution", detail: sentinel },
      },
      cells: [],
      counts: { expected: 0, dispatched: 0, delivered: 0, judged: 0, failed: 0, awaitingEvaluation: 0 },
    });
    loadRunViewMock.mockReturnValue({
      ok: true,
      draft: { ok: true, result: {} },
      status: { ok: true, result: projected },
    });
    const markup = renderToStaticMarkup(await RunMonitorPage({
      params: Promise.resolve({ draftId: "draft-1" }),
    }));
    expect(markup).toContain("execution");
    expect(markup).toContain("server logs");
    expect(markup).not.toContain(sentinel);
    expect(markup).not.toContain("VERY_SECRET");
  });

  test("marks a cell stranded between its delivered event and its delivery record (#3084)", async () => {
    loadRunViewMock.mockReturnValue({
      ok: true,
      draft: { ok: true, result: {} },
      status: { ok: true, result: {
        state: "running",
        cancelRequested: false,
        cells: [
          {
            cellKey: "cell-stranded", armId: "baseline", replicate: 1, taskSha256: "a".repeat(64),
            status: "delivered", dispatches: 1,
            evaluationGap: { missingEvalIndexes: [1], deliveryJournaled: false },
          },
          {
            cellKey: "cell-judged", armId: "baseline", replicate: 2, taskSha256: "b".repeat(64),
            status: "judged", dispatches: 1,
          },
        ],
        counts: { expected: 2, dispatched: 2, delivered: 1, judged: 1, failed: 0, awaitingEvaluation: 1 },
      } },
    });
    const markup = renderToStaticMarkup(await RunMonitorPage({
      params: Promise.resolve({ draftId: "draft-1" }),
    }));
    expect(markup).toContain("awaiting evaluation (delivery not journaled)");
  });
});
