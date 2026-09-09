// `pickAbiItems` exists in two copies: `src/pick.ts` (published, consumed by tests and by
// `@jinn-network/contract-abis/pick`) and `scripts/lib.mjs` (used by `yarn generate`, which must
// not depend on a prior `yarn build`). The duplication is deliberate; these tests run every case
// through both copies so a divergence is a test failure rather than a silent one.
import { describe, expect, it } from "vitest";
import { pickAbiItems as pickTs, type AbiItem } from "../src/pick.js";
import { pickAbiItems as pickMjs } from "../scripts/lib.mjs";

const impls = [
  ["src/pick.ts", pickTs],
  ["scripts/lib.mjs", pickMjs],
] as const;

function inputTypes(item: AbiItem): readonly string[] {
  return (item.inputs ?? []).map((input) => input.type);
}

// No committed contract has a name collision, so the collision cases are built here.
const OVERLOADED_ABI: AbiItem[] = [
  {
    type: "function",
    name: "claimTask",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "taskId" },
      { type: "address", name: "solver" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimTask",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "taskId" },
      { type: "address", name: "solver" },
      { type: "uint256", name: "deadline" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "closeTask",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256", name: "taskId" }],
    outputs: [],
  },
];

const CROSS_TYPE_ABI: AbiItem[] = [
  { type: "function", name: "Foo", stateMutability: "view", inputs: [], outputs: [] },
  { type: "event", name: "Foo", inputs: [{ type: "uint256", name: "value", indexed: false }] },
];

const TUPLE_ABI: AbiItem[] = [
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256", name: "id" }],
    outputs: [],
  },
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        name: "record",
        components: [
          { type: "uint32", name: "maxClaims" },
          { type: "bool", name: "allowSelfEvaluation" },
        ],
      },
    ],
    outputs: [],
  },
];

describe.each(impls)("pickAbiItems (%s)", (_label, pick) => {
  it("throws on an overloaded name, naming every colliding signature", () => {
    expect(() => pick(OVERLOADED_ABI, ["claimTask"])).toThrow(
      /Ambiguous ABI item "claimTask"/,
    );
    try {
      pick(OVERLOADED_ABI, ["claimTask"]);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("function claimTask(uint256,address)");
      expect(message).toContain("function claimTask(uint256,address,uint256)");
      expect(message).toContain("2 items match:");
    }
  });

  it("throws on a function/event name collision", () => {
    expect(() => pick(CROSS_TYPE_ABI, ["Foo"])).toThrow(/Ambiguous ABI item "Foo"/);
    try {
      pick(CROSS_TYPE_ABI, ["Foo"]);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("function Foo()");
      expect(message).toContain("event Foo(uint256)");
    }
  });

  it("selects the intended overload from a canonical signature", () => {
    const [picked] = pick(OVERLOADED_ABI, ["claimTask(uint256,address)"]);
    expect(picked.name).toBe("claimTask");
    expect(inputTypes(picked)).toEqual(["uint256", "address"]);

    const [wider] = pick(OVERLOADED_ABI, ["claimTask(uint256,address,uint256)"]);
    expect(inputTypes(wider)).toEqual(["uint256", "address", "uint256"]);

    // The signature form also disambiguates across item types, and preserves manifest order.
    const both = pick(CROSS_TYPE_ABI, ["Foo(uint256)", "Foo()"]);
    expect(both.map((item: AbiItem) => item.type)).toEqual(["event", "function"]);
  });

  it("expands tuple inputs in the signature form", () => {
    const [picked] = pick(TUPLE_ABI, ["submit((uint32,bool))"]);
    expect(inputTypes(picked)).toEqual(["tuple"]);
    const [scalar] = pick(TUPLE_ABI, ["submit(uint256)"]);
    expect(inputTypes(scalar)).toEqual(["uint256"]);
  });

  it("resolves a unique bare name, preserving manifest order", () => {
    const picked = pick(OVERLOADED_ABI, ["closeTask"]);
    expect(picked.map((item: AbiItem) => item.name)).toEqual(["closeTask"]);
    expect(inputTypes(picked[0])).toEqual(["uint256"]);
  });

  it("keeps the not-found message for a name and for a signature", () => {
    expect(() => pick(OVERLOADED_ABI, ["missing"])).toThrow("ABI item not found: missing");
    expect(() => pick(OVERLOADED_ABI, ["claimTask(uint256)"])).toThrow(
      "ABI item not found: claimTask(uint256)",
    );
  });

  it("names the supplied context in the ambiguity message", () => {
    expect(() =>
      pick(OVERLOADED_ABI, ["claimTask"], "slice bindingJinnRouterV4 (contract JinnRouterV4)"),
    ).toThrow(
      /Ambiguous ABI item "claimTask" in slice bindingJinnRouterV4 \(contract JinnRouterV4\):/,
    );
  });
});

it("produces byte-identical ambiguity messages from both copies", () => {
  const messages = impls.map(([, pick]) => {
    try {
      pick(OVERLOADED_ABI, ["claimTask"], "slice s (contract C)");
    } catch (error) {
      return (error as Error).message;
    }
    return "did not throw";
  });
  expect(messages[0]).toBe(messages[1]);
  expect(messages[0]).not.toBe("did not throw");
});
