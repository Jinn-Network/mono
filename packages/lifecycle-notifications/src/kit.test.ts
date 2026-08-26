import { describe, expect, it } from "vitest";

import { buildNotifications, type NotificationsBuildInput } from "./derive.js";
import { NOTIFICATION_KINDS } from "./kinds.js";
import { createFundingEmptyDeriver } from "./testing.js";

const healthy: NotificationsBuildInput = {
  bootstrapMode: "running",
  executionWiring: [{ workKind: "bafkreic-x" }],
  funds: {
    chains: [{ chain: "Base Sepolia", wallet: "0xM", runwayDays: 30, empty: false }],
  },
  harness: { ready: true, name: "claude-code", reason: null },
  rpc: { reachable: true },
  restartRequired: false,
  daemonVersion: "0.1.5",
  latestVersion: "0.1.5",
  services: [{ safeBound: true }],
};

function assertEnvelope(notices: ReturnType<typeof buildNotifications>) {
  for (const notice of notices) {
    expect(typeof notice.kind).toBe("string");
    expect(notice.kind.length).toBeGreaterThan(0);
    expect(["blocking", "warning", "info"]).toContain(notice.severity);
    expect(notice.title.length).toBeGreaterThan(0);
    expect(notice.message.length).toBeGreaterThan(0);
  }
}

describe("notification derivation kit", () => {
  it("names the sixteen canonical kinds", () => {
    expect(NOTIFICATION_KINDS).toHaveLength(16);
  });

  it("is a pure function: the production deriver is deterministic", () => {
    const first = buildNotifications(healthy);
    const second = buildNotifications(healthy);
    expect(first).toEqual(second);
    expect(first).toEqual([]);
  });

  it("renders every notice from envelope fields (unknown-kind rule)", () => {
    const notices = buildNotifications({
      ...healthy,
      funds: { chains: [{ chain: "Base Sepolia", wallet: "0xM", runwayDays: 1, empty: true }] },
    });
    expect(notices).toHaveLength(1);
    assertEnvelope(notices);
  });

  it("points empty wiring at Claim policy, not Settings", () => {
    const notices = buildNotifications({
      ...healthy,
      executionWiring: [],
    });
    expect(notices).toEqual([
      {
        kind: "no_solvernets_joined",
        severity: "info",
        title: "No SolverNets joined",
        message: "No execution wiring configured. Add a work kind in Claim policy.",
        jumpTo: "/operator/claim-policy",
      },
    ]);
  });
});

describe("the in-tree fake", () => {
  it("proves the kit passable: empty funds yield a blocking funding_empty notice", () => {
    const deriver = createFundingEmptyDeriver();
    const notices = deriver({
      ...healthy,
      funds: { chains: [{ chain: "Base Sepolia", wallet: "0xM", runwayDays: 0, empty: true }] },
    });
    expect(notices).toEqual([
      {
        kind: "funding_empty",
        severity: "blocking",
        title: "Gas exhausted",
        message: "Gas exhausted — 0xM on Base Sepolia can't cover the next transaction.",
        jumpTo: "/overview",
      },
    ]);
    assertEnvelope(notices);
  });

  it("stays silent when no chain is empty", () => {
    const deriver = createFundingEmptyDeriver();
    expect(deriver(healthy)).toEqual([]);
  });
});
