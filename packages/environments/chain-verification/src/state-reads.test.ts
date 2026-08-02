// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadKeyCorpus } from "./abi-vectors.js";
import { ChainVerificationError } from "./errors.js";
import type { RpcTransport } from "./runtime-hosts.js";
import { resolveStateReads, stateReadKey } from "./state-reads.js";

const REQUEST = {
  to: "0x00000000000000000000000000000000000000aa",
  signature: "getReserveData(address)",
  args: ["0x00000000000000000000000000000000000000bb"],
  returns: ["uint256"],
  state: "baseline",
} as const;

function fakeRpcTransport(
  responses: Record<string, string> = {},
): RpcTransport & { calls: Array<{ method: string; params: unknown[] }> } {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  return {
    calls,
    async send(request) {
      calls.push({ method: request.method, params: [...request.params] });
      const call = request.params[0] as { data?: string };
      const data = call.data ?? "";
      for (const [prefix, response] of Object.entries(responses)) {
        if (data.startsWith(prefix)) return response;
      }
      return "0x" + "0".repeat(64);
    },
  };
}

function revertingTransport(): RpcTransport {
  return {
    async send() {
      const error = new Error("execution reverted") as Error & { data?: string };
      error.data = "0x08c379a00000000000000000000000000000000000000000000000000000000000000020";
      throw error;
    },
  };
}

describe("stateReadKey", () => {
  it("is a pure function of the request", () => {
    expect(stateReadKey(REQUEST)).toBe(stateReadKey({ ...REQUEST }));
  });

  it("separates the two worlds, so a baseline read never answers a post-replay lookup", () => {
    expect(stateReadKey(REQUEST))
      .not.toBe(stateReadKey({ ...REQUEST, state: "post-replay" }));
  });

  it("distinguishes every field a different call would differ in", () => {
    for (const mutation of [
      { to: "0x00000000000000000000000000000000000000cc" },
      { signature: "getReserveData(address,uint256)" },
      { args: ["0x00000000000000000000000000000000000000cc"] },
      { returns: ["uint128"] },
    ]) {
      expect(stateReadKey({ ...REQUEST, ...mutation })).not.toBe(stateReadKey(REQUEST));
    }
  });

  it("matches the committed key corpus CE2 derives against", async () => {
    const corpus = await loadKeyCorpus();
    for (const entry of corpus) {
      expect(stateReadKey(entry.request)).toBe(entry.key);
    }
    expect(corpus.length).toBeGreaterThanOrEqual(8);
  });
});

describe("resolveStateReads", () => {
  it("encodes once, calls through the transport, and keys the outcome", async () => {
    const transport = fakeRpcTransport({ "0x": "0x" + "0".repeat(63) + "7" });
    const outcomes = await resolveStateReads(transport, "http://runner.local", [REQUEST], {
      state: "baseline",
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      key: stateReadKey(REQUEST),
      state: "baseline",
      to: REQUEST.to,
      status: "success",
    });
    expect(outcomes[0]!.calldata.startsWith("0x")).toBe(true);
  });

  it("produces identical calldata on every run for the same request", async () => {
    const first = await resolveStateReads(fakeRpcTransport(), "http://runner.local", [REQUEST], { state: "baseline" });
    const second = await resolveStateReads(fakeRpcTransport(), "http://runner.local", [REQUEST], { state: "baseline" });
    expect(second[0]!.calldata).toBe(first[0]!.calldata);
    expect(second[0]!.key).toBe(first[0]!.key);
  });

  it("executes only the reads tagged for the world it was given", async () => {
    const transport = fakeRpcTransport();
    const outcomes = await resolveStateReads(
      transport,
      "http://runner.local",
      [REQUEST, { ...REQUEST, state: "post-replay" }],
      { state: "baseline" },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.state).toBe("baseline");
    expect(transport.calls).toHaveLength(1);
  });

  it("records a revert as an observation, not an error", async () => {
    const outcomes = await resolveStateReads(
      revertingTransport(), "http://runner.local", [REQUEST], { state: "baseline" },
    );
    expect(outcomes[0]).toMatchObject({ status: "reverted", returnData: expect.any(String) });
  });

  it("refuses a request whose args do not match its signature", async () => {
    await expect(resolveStateReads(
      fakeRpcTransport(), "http://runner.local",
      [{ ...REQUEST, args: [] }], { state: "baseline" },
    )).rejects.toThrow(ChainVerificationError);
  });
});
