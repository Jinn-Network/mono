// SPDX-License-Identifier: Apache-2.0

import { cleanupHarnessSubtree, establishSubreaperCustody, installCustodianSignalGuards } from "./shim-control.js";
import { describe, expect, it } from "vitest";

describe("portable shim custody controller", () => {
  it("signals the subtree before reaping its leader", async () => {
    const effects: string[] = [];
    const result = await cleanupHarnessSubtree({
      signalHarnessSubtree: (signal) => { effects.push(`signal:${signal}`); },
      reapHarnessLeader: () => { effects.push("reap:leader"); },
    });
    expect(result).toEqual({ signalDelivered: true, leaderReaped: true });
    expect(effects).toEqual(["signal:SIGKILL", "reap:leader"]);
  });

  it("makes the subreaper outcome and signal guards observable through ports", async () => {
    const handlers: string[] = [];
    expect(establishSubreaperCustody({ enableSubreaper: () => true })).toEqual({ subreaper: true, visibleToCustodyScan: true });
    installCustodianSignalGuards({ ignoreSignal: (signal) => { handlers.push(signal); } });
    expect(handlers).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
  });
});
