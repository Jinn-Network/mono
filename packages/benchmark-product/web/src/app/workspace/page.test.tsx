/**
 * The commissioning desk's workspace-scoped controls. The anchoring card is the reason this file
 * exists: a registered GUI action nobody renders is a capability the spec claims and the product
 * does not have, so the control is asserted here rather than trusted to the registry alone.
 */

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const loadWorkspaceViewMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/view-models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/view-models")>(),
  loadWorkspaceView: loadWorkspaceViewMock,
}));
vi.mock("@/lib/server/gui-action-registry", () => ({
  GUI_SERVER_ACTIONS: {
    "workspace.init": vi.fn(),
    "authority.grant": vi.fn(),
    "authority.revoke": vi.fn(),
    "anchoring.configure": vi.fn(),
  },
}));
vi.mock("@/components/action-form", () => ({
  ActionForm: ({ submitLabel, children, disabled }: { readonly submitLabel: string; readonly children?: ReactNode; readonly disabled?: boolean }) => <form><button disabled={disabled}>{submitLabel}</button>{children}</form>,
}));

import WorkspacePage from "./page";

function view(anchoring: { available: boolean; providerProfiles: readonly string[] }) {
  return {
    ok: true as const,
    configuration: { principal: "sponsor-1" },
    drafts: { ok: true as const, result: { drafts: [] } },
    authority: { ok: true as const, result: { policy: { policyVersion: 1, principals: [] } } },
    anchoringConfiguration: anchoring,
  };
}

describe("workspace anchoring control", () => {
  beforeEach(() => loadWorkspaceViewMock.mockReset());

  test("renders both anchoring controls, naming profiles and never an endpoint", () => {
    loadWorkspaceViewMock.mockReturnValue(view({
      available: true,
      providerProfiles: ["https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1"],
    }));

    const markup = renderToStaticMarkup(WorkspacePage());

    expect(markup).toContain("Third-party time");
    expect(markup).toContain("Apply the configured anchor providers");
    expect(markup).toContain("Turn anchoring off");
    expect(markup).toContain('name="clear" value="clear-anchoring"');
    expect(markup).toContain("https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1");
    expect(markup).not.toContain('name="endpoint"');
    expect(markup).not.toContain('name="providerProfile"');
    expect(markup).not.toContain('<button disabled="">Apply the configured anchor providers');
  });

  test("disables applying when the server configures no providers, and still allows turning it off", () => {
    loadWorkspaceViewMock.mockReturnValue(view({ available: false, providerProfiles: [] }));

    const markup = renderToStaticMarkup(WorkspacePage());

    expect(markup).toContain("Unavailable — set the anchor providers on the server.");
    expect(markup).toContain('<button disabled="">Apply the configured anchor providers');
    expect(markup).not.toContain('<button disabled="">Turn anchoring off');
  });
});
