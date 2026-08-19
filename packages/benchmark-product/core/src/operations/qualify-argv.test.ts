import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "../../scripts");

const QUALIFY = [
  {
    file: "tb21-one-task-qualify.mjs",
    env: "COLOPHON_TB21_ONE_TASK_QUALIFY",
    catalog: "terminal-bench-2.1",
  },
  {
    file: "tb30-one-task-qualify.mjs",
    env: "COLOPHON_TB30_ONE_TASK_QUALIFY",
    catalog: "terminal-bench-3.0",
  },
  {
    file: "swebench-verified-one-task-qualify.mjs",
    env: "COLOPHON_SWEBENCH_VERIFIED_ONE_TASK_QUALIFY",
    catalog: "swe-bench-verified",
  },
  {
    file: "apex-agents-one-task-qualify.mjs",
    env: "COLOPHON_APEX_AGENTS_ONE_TASK_QUALIFY",
    catalog: "apex-agents",
  },
  {
    file: "apex-swe-dev-one-task-qualify.mjs",
    env: "COLOPHON_APEX_SWE_DEV_ONE_TASK_QUALIFY",
    catalog: "apex-swe-dev",
  },
] as const;

describe("qualify scripts", () => {
  test("keep fail-closed env names and use method/export argv", () => {
    for (const row of QUALIFY) {
      const text = readFileSync(join(scriptsDir, row.file), "utf8");
      expect(text, row.file).toContain(`${row.env} !== "1"`);
      expect(text, row.file).toContain(`["method", "${row.catalog}"`);
      expect(text, row.file).toContain('["export"');
      expect(text, row.file).toContain("--slice");
      expect(text, row.file).toContain("--host");
      expect(text, row.file).not.toMatch(/\["runtime"/u);
      expect(text, row.file).not.toMatch(/\["hub"/u);
      expect(text, row.file).not.toMatch(/\["swebench", "export"/u);
      expect(text, row.file).not.toMatch(/\["apex-agents", "export"/u);
      expect(text, row.file).not.toMatch(/\["apex-swe"/u);
    }
  });
});
