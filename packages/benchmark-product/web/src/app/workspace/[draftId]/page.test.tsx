import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const loadDraftViewMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/view-models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/view-models")>(),
  loadDraftView: loadDraftViewMock,
}));
vi.mock("@/lib/server/gui-action-registry", () => ({
  GUI_SERVER_ACTIONS: {
    "draft.update": vi.fn(),
    "intake.sample": vi.fn(),
    "intake.swebench": vi.fn(),
    "method.bind": vi.fn(),
    "arm.add": vi.fn(),
    "arm.update": vi.fn(),
    "arm.remove": vi.fn(),
    "run.preview": vi.fn(),
    "run.quote": vi.fn(),
    "run.lock": vi.fn(),
  },
}));
vi.mock("@/app/actions", () => ({ agentProfileArmAddAction: vi.fn() }));
vi.mock("@/components/action-form", () => ({
  ActionForm: ({ submitLabel, disabled, notice, children }: { readonly submitLabel: string; readonly disabled?: boolean; readonly notice?: string; readonly children?: React.ReactNode }) => <form><button disabled={disabled}>{submitLabel}</button>{notice === undefined ? null : <p>{notice}</p>}{children}</form>,
}));

import DraftPage from "./page";

describe("guided own-work draft surface", () => {
  beforeEach(() => loadDraftViewMock.mockReset());

  test("renders safe configured-agent choices, doctor readiness, and the cost disclosure before lock", async () => {
    const privateSentinel = "/private/colophon/agents/codex/auth.json";
    loadDraftViewMock.mockReturnValue({
      ok: true,
      draft: { ok: true, result: { draft: { state: "draft" } } },
      inspection: { ok: true, result: {} },
      arms: { ok: true, result: { arms: [] } },
      agentProfiles: {
        status: "available",
        profiles: [{
          agentId: "codex-main",
          adapter: "codex",
          model: "gpt-5.6",
          effort: "high",
          readiness: "needs-credential",
        }],
      },
      agentReadiness: { required: false, ready: true, findings: [] },
    });

    const markup = renderToStaticMarkup(await DraftPage({ params: Promise.resolve({ draftId: "draft-1" }) }));

    expect(markup).toContain("Configured agents");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Needs a Colophon credential before a provider run");
    expect(markup).toContain("Add selected agent as an Arm");
    expect(markup).toContain("This adds only the harness, model, effort, and digest identity.");
    expect(markup).toContain("Advanced: raw Arm pinning");
    expect(markup).toContain("Provider network and possible charges.");
    expect(markup).toContain("before you quote, lock, or launch your own work");
    expect(markup).not.toContain(privateSentinel);
    expect(markup).not.toContain("auth.json");
  });

  test("surfaces safe remediation and disables quote when a selected real agent fails doctor", async () => {
    const privateSentinel = "/private/operator/bin/codex";
    loadDraftViewMock.mockReturnValue({
      ok: true,
      draft: { ok: true, result: { draft: { state: "draft" } } },
      inspection: { ok: true, result: {} },
      arms: { ok: true, result: { arms: [] } },
      agentProfiles: { status: "available", profiles: [] },
      agentReadiness: {
        required: true,
        ready: false,
        findings: [{
          armId: "candidate",
          adapter: "codex",
          ready: false,
          code: "credential-missing",
          detail: "Codex has no usable Colophon credential grant. A real run may make paid provider calls.",
          remediation: "Run colophon agent login --agent codex-main for a qualified subscription build, or explicitly import an API key file.",
        }],
      },
    });

    const markup = renderToStaticMarkup(await DraftPage({ params: Promise.resolve({ draftId: "draft-1" }) }));

    expect(markup).toContain("Real agent setup is not ready");
    expect(markup).toContain("This check makes no provider request.");
    expect(markup).toContain("colophon agent login");
    expect(markup).toContain("<button disabled=\"\">Quote</button>");
    expect(markup).not.toContain(privateSentinel);
  });
});
