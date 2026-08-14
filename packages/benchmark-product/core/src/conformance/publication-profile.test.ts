import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

type Case = { readonly id: string; readonly status: "covered" | "partial" | "deferred"; readonly disposition?: string; readonly remaining?: string; readonly tests: readonly string[] };
type Manifest = { readonly profile: string; readonly version: number; readonly owner: string; readonly scope: string; readonly cases: readonly Case[] };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = resolve(packageRoot, "test/fixtures/benchmark-publication-conformance/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

describe("Benchmark Publication Interoperability Profile conformance kit", () => {
  test("is a complete, honest, executable application-acceptance index", () => {
    expect(manifest).toMatchObject({
      profile: "https://spec.jinn.network/profiles/benchmark-publication/v1",
      version: 1,
      owner: "@jinn-network/benchmark-product-core",
    });
    expect(manifest.cases.map((entry) => entry.id)).toEqual(Array.from({ length: 18 }, (_, index) => `${index + 1}-`).map((prefix) => expect.stringMatching(new RegExp(`^${prefix}`))));
    for (const entry of manifest.cases) {
      if (entry.status === "covered") expect(entry.tests.length, entry.id).toBeGreaterThan(0);
      if (entry.status !== "covered") expect(entry.disposition ?? entry.remaining, entry.id).toEqual(expect.any(String));
      for (const testPath of entry.tests) expect(existsSync(resolve(packageRoot, testPath)), `${entry.id}: ${testPath}`).toBe(true);
    }
  });

  test("keeps deferred fixture 5, fixture 6, and fixture 13 marketplace work explicit", () => {
    const byId = new Map(manifest.cases.map((entry) => [entry.id, entry]));
    expect(byId.get("5-arbitrary-completed-harbor-history")).toMatchObject({ status: "deferred" });
    expect(byId.get("6-marketplace-operator-harbor")).toMatchObject({ status: "deferred" });
    expect(byId.get("13-equal-benchmark-identity-across-venues")).toMatchObject({ status: "partial" });
  });
});
