import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(sourceRoot, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1] as string);
}

describe("admission is attestation-agnostic by construction (design §7.1, program contract 7)", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it("declares exactly two Jinn dependencies and no verification or issuer package", () => {
    const jinn = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ].filter((name) => name.startsWith("@jinn-network/")).sort();
    expect(jinn).toStrictEqual([
      "@jinn-network/environment-record",
      "@jinn-network/trust-core",
    ]);
  });

  it("imports no attestation or environment-verification module anywhere in the package", () => {
    const offenders = sourceFiles(sourceRoot).flatMap((file) =>
      importSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => /attestation|environment-verification/i.test(specifier))
        .map((specifier) => `${file} -> ${specifier}`),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("exports no symbol whose name claims anything about attestations", async () => {
    const surface = await import("./index.js");
    const offenders = Object.keys(surface).filter((name) => /attest/i.test(name));
    expect(offenders).toStrictEqual([]);
  });
});
