import { describe, expect, test } from "vitest";

import { CapabilityEnvelopeSchema } from "./envelope.js";

const envelope = () => ({
  toolInterfaces: [
    { id: "jinn.chain-tools", version: "1.0", schema: { name: "tools", digest: { sha256: "1".repeat(64) } } },
  ],
  rpc: {
    readMethods: ["eth_call", "eth_getBalance", "eth_getBlockByNumber"],
    stateChangingMethods: ["eth_sendRawTransaction", "evm_mine"],
  },
  signerRoles: [
    { role: "agent", accounts: [`0x${"a1".repeat(20)}`] },
  ],
  permittedChainId: 1,
  limits: {
    maxTransactions: 25,
    maxAggregateNativeValueWei: "5000000000000000000",
    tokenSpendPolicies: [{ token: `0x${"d0".repeat(20)}`, maxSpendUnits: "1000000000" }],
    maxGasPerTransaction: "5000000",
    maxAggregateGas: "60000000",
    maxExecutionDurationMs: 600_000,
    maxBlockAdvance: 500,
    maxChainSecondsAdvance: 604_800,
  },
  egressPolicyId: "jinn.egress.blackhole/1",
});

const parse = (document: unknown) => CapabilityEnvelopeSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("capability envelope (§4.3)", () => {
  test("accepts a fully bounded envelope", () => {
    expect(parse(envelope()).success).toBe(true);
  });

  test("refuses a method that is both read and state-changing", () => {
    const document = envelope();
    document.rpc.readMethods.push("evm_mine");
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("both");
  });

  test("refuses duplicate methods inside one allowlist", () => {
    const document = envelope();
    document.rpc.readMethods.push("eth_call");
    expect(parse(document).success).toBe(false);
  });

  test("requires at least one read method: a world with no reads has no agent surface", () => {
    const document = envelope();
    document.rpc.readMethods = [];
    expect(parse(document).success).toBe(false);
  });

  test("refuses duplicate signer roles and an account bound to two roles", () => {
    const twoRoles = envelope();
    twoRoles.signerRoles = [
      { role: "agent", accounts: [`0x${"a1".repeat(20)}`] },
      { role: "rescuer", accounts: [`0x${"a1".repeat(20)}`] },
    ];
    expect(parse(twoRoles).success).toBe(false);

    const sameRole = envelope();
    sameRole.signerRoles = [
      { role: "agent", accounts: [`0x${"a1".repeat(20)}`] },
      { role: "agent", accounts: [`0x${"b2".repeat(20)}`] },
    ];
    expect(parse(sameRole).success).toBe(false);
  });

  test("carries roles and policy, never credentials", () => {
    const document = envelope() as Record<string, unknown>;
    (document.signerRoles as Record<string, unknown>[])[0].keystore = "0xdeadbeef";
    expect(parse(document).success).toBe(false);
  });

  test("every ceiling is required: an absent maximum is an unbounded capability", () => {
    for (const key of [
      "maxTransactions", "maxAggregateNativeValueWei", "tokenSpendPolicies", "maxGasPerTransaction",
      "maxAggregateGas", "maxExecutionDurationMs", "maxBlockAdvance", "maxChainSecondsAdvance",
    ]) {
      const document = envelope() as { limits: Record<string, unknown> };
      delete document.limits[key];
      expect(parse(document).success, key).toBe(false);
    }
  });

  test("an empty token-spend policy list is legal — it declares no token ceilings, explicitly", () => {
    const document = envelope();
    document.limits.tokenSpendPolicies = [];
    expect(parse(document).success).toBe(true);
  });

  test("requires an egress policy identifier", () => {
    const document = envelope() as Record<string, unknown>;
    delete document.egressPolicyId;
    expect(parse(document).success).toBe(false);
  });
});
