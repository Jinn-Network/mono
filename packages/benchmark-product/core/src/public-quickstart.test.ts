import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(coreRoot, "quickstart/public-quickstart.mjs");
const prefix = "benchmark-product-public-quickstart-";

describe("public quickstart safety contract", () => {
  it("is a package command over the built CLI and the real local venue", () => {
    const packageJson = JSON.parse(readFileSync(resolve(coreRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["public-quickstart"]).toBe("./quickstart/public-quickstart.mjs");

    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain('"dist", "cli", "bin.js"');
    expect(source).toContain('"prediction-v1-baseline"');
    expect(source).toContain('"sample-uniform"');
    expect(source).toContain('"bundle", "verify"');
    expect(source).not.toMatch(/in-memory|task-execution-testing|src\/operations/i);
  });

  it("rejects caller-selected paths before creating a temporary root", () => {
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix)).sort();
    const result = spawnSync(process.execPath, [scriptPath, "--workspace", "/"], {
      cwd: coreRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix)).sort();

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/takes no arguments.*caller-selected paths/i);
    expect(after).toEqual(before);
  });
});
