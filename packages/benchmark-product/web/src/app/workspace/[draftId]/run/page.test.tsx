import { renderToStaticMarkup } from "react-dom/server";
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
  },
}));
vi.mock("@/components/action-form", () => ({
  ActionForm: ({ submitLabel }: { readonly submitLabel: string }) => <form>{submitLabel}</form>,
}));
vi.mock("@/components/run-monitor-refresh", () => ({ RunMonitorRefresh: () => <button>Refresh</button> }));

import RunMonitorPage from "./page";
import { projectRunStatusForGui } from "@/lib/server/view-models";

function status(state: "running" | "closed", cancelRequested: boolean) {
  return {
    ok: true as const,
    draft: { ok: true as const, result: {} },
    status: {
      ok: true as const,
      result: {
        state,
        cancelRequested,
        cells: [],
        counts: { expected: 6, dispatched: 6, delivered: 0, judged: 0, failed: 6 },
      },
    },
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
  });

  test("calls a closed run with a valid marker finalized and cancelled", async () => {
    loadRunViewMock.mockReturnValue(status("closed", true));
    const markup = renderToStaticMarkup(await RunMonitorPage({
      params: Promise.resolve({ draftId: "draft-1" }),
    }));
    expect(markup).toContain("Cancellation finalized; run is cancelled.");
    expect(markup).not.toContain("Cancellation requested; driver is draining.");
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
      counts: { expected: 0, dispatched: 0, delivered: 0, judged: 0, failed: 0 },
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
});
