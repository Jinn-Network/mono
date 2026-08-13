import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { HarborJobConfigSchema, assertSupportedHarborVersion } from "../harbor/manifest.js";
import { TERMINAL_BENCH_2_DATASET_ID } from "./manifest.js";

const optedIn = process.env.COLOPHON_TERMINAL_BENCH_2_EXTERNAL === "1";
const invoke = async (executable: string, argv: readonly string[]) => await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  execFile(executable, [...argv], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1" }, maxBuffer: 32 * 1024 * 1024 },
    (error, stdout, stderr) => error === null ? resolve({ stdout, stderr }) : reject(new Error(`${executable} ${argv.join(" ")} failed: ${stderr}`, { cause: error })));
});

test.skipIf(!optedIn)("opt-in real Harbor 0.21 / Terminal-Bench 2 smoke executes one Trial", async ({ skip }) => {
  const harbor = process.env.COLOPHON_TERMINAL_BENCH_2_HARBOR;
  const docker = process.env.COLOPHON_TERMINAL_BENCH_2_DOCKER ?? "docker";
  const configPath = process.env.COLOPHON_TERMINAL_BENCH_2_EXTERNAL_CONFIG;
  if (harbor === undefined || configPath === undefined || !existsSync(harbor) || !existsSync(configPath)) {
    console.warn("TB2 external check skipped: set COLOPHON_TERMINAL_BENCH_2_HARBOR and COLOPHON_TERMINAL_BENCH_2_EXTERNAL_CONFIG to exact local files");
    skip(); return;
  }
  try { await invoke(docker, ["info", "--format", "{{json .ServerVersion}}"]) } catch {
    console.warn("TB2 smoke skipped: Docker CLI/daemon unavailable"); skip(); return;
  }
  const version = (await invoke(harbor, ["--version"])).stdout.trim().replace(/^harbor\s+/iu, "");
  assertSupportedHarborVersion(version);
  const config = HarborJobConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  if (!("datasets" in config) || !("name" in config.datasets[0]) || config.datasets[0].name !== TERMINAL_BENCH_2_DATASET_ID
    || !("ref" in config.datasets[0]) || !/^sha256:[a-f0-9]{64}$/u.test(config.datasets[0].ref)
    || config.datasets[0].task_names.length !== 1 || config.datasets[0].n_tasks !== 1) {
    throw new TypeError("real TB2 smoke config must select one task from the immutable canonical Terminal-Bench 2 dataset");
  }
  await invoke(harbor, ["run", "-c", configPath]);
  const jobRoot = join(config.jobs_dir, config.job_name);
  const trials = readdirSync(jobRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()
    && existsSync(join(jobRoot, entry.name, "config.json")) && existsSync(join(jobRoot, entry.name, "result.json")));
  if (trials.length !== 1) throw new TypeError(`real TB2 smoke expected exactly one Harbor Trial, found ${trials.length}`);
});
