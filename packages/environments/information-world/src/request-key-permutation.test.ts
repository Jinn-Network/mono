import { describe, expect, test } from "vitest";

import type { RequestKeyPolicy } from "./request-key-policy.js";
import { canonicalRequestKey } from "./request-key.js";

const policy: RequestKeyPolicy = {
  version: "irk1",
  headerSubset: ["accept", "content-type", "x-chain"],
  pathTrailingSlash: "preserve",
  plusInQuery: "literal",
  bodyCanonicalization: "json-jcs",
};

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([
    ...items.slice(0, index),
    ...items.slice(index + 1),
  ]).map((rest) => [item, ...rest]));
}

const declaredHeaders: readonly (readonly [string, string])[] = [
  ["accept", "application/json"],
  ["Content-Type", "application/json"],
  ["X-Chain", "base"],
];

const noiseHeaders: readonly (readonly [string, string])[] = [
  ["user-agent", "solver/9.9.9"],
  ["accept-encoding", "gzip, deflate, br"],
  ["traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"],
];

const queryPairs = ["chain=base", "limit=50", "sort=apy"];
const bodies = [
  '{"filter":{"minTvl":1000000,"asset":"USDC"},"page":1}',
  '{ "page": 1, "filter": { "asset": "USDC", "minTvl": 1000000 } }',
];

describe("request-key equivalence under permutation", () => {
  test("every declared-header permutation, with noise on either side, yields one key", () => {
    const url = "https://api.example.test/pools?chain=base";
    const body = new TextEncoder().encode(bodies[0]);
    const keys = new Set<string>();
    for (const ordered of permutations(declaredHeaders)) {
      keys.add(canonicalRequestKey({ method: "POST", url, headers: ordered, body }, policy));
      for (const noise of permutations(noiseHeaders)) {
        keys.add(canonicalRequestKey({
          method: "POST",
          url,
          headers: [...noise, ...ordered],
          body,
        }, policy));
        keys.add(canonicalRequestKey({
          method: "POST",
          url,
          headers: [...ordered, ...noise],
          body,
        }, policy));
      }
    }
    expect(keys.size, [...keys].join("\n")).toBe(1);
  });

  test("every query permutation yields one key", () => {
    const keys = new Set(permutations(queryPairs).map((ordered) => canonicalRequestKey({
      method: "GET",
      url: `https://api.example.test/pools?${ordered.join("&")}`,
    }, policy)));
    expect(keys.size, [...keys].join("\n")).toBe(1);
  });

  test("JSON member order and whitespace yield one body key under json-jcs", () => {
    const keys = new Set(bodies.map((body) => canonicalRequestKey({
      method: "POST",
      url: "https://api.example.test/pools",
      headers: [["content-type", "application/json"]],
      body: new TextEncoder().encode(body),
    }, policy)));
    expect(keys.size).toBe(1);
  });

  test("the complete permutation space collapses, while one material difference splits it", () => {
    const url = "https://api.example.test/pools";
    const body = new TextEncoder().encode(bodies[0]);
    const keys = new Set<string>();
    for (const headers of permutations(declaredHeaders)) {
      for (const query of permutations(queryPairs)) {
        keys.add(canonicalRequestKey({
          method: "POST",
          url: `${url}?${query.join("&")}`,
          headers,
          body,
        }, policy));
      }
    }
    expect(keys.size).toBe(1);
    const changed = canonicalRequestKey({
      method: "POST",
      url: `${url}?${queryPairs.join("&")}`,
      headers: [...declaredHeaders.slice(0, 2), ["x-chain", "optimism"]],
      body,
    }, policy);
    expect(keys.has(changed)).toBe(false);
  });
});
