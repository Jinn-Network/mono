#!/usr/bin/env node

/**
 * The cold-start walking-skeleton harness (BP-14, deliverable 2): drives the BUILT CLI
 * (`dist/cli/bin.js` — built automatically if missing) as REAL child processes, in a fresh
 * `mkdtemp` workspace, through the complete M1 lifecycle — init through verify — with a real
 * sponsor/delegated-agent authority split and the real local venue (real subprocess launchers,
 * real evaluation harness). This is evidence, not a test: every step asserts the CLI's own
 * `{ok:true}` JSON envelope and exits loud on the first thing that does not check out.
 *
 * Sequence (every call `--json`):
 *   init -> authority show -> draft create -> sample init -> arm add (x2) -> inspect ->
 *   authority grant (delegated agent, lock+launch) -> quote -> lock (AS DELEGATED AGENT) ->
 *   launch (AS DELEGATED AGENT, real venue, real subprocesses) -> status -> collect -> results ->
 *   report -> verify.
 *
 * `lock` and `launch` run under `--principal delegated-agent-1` (a principal the sponsor grants
 * ONLY the `lock`/`launch` operations to, per `../src/authority/policy.ts`'s `GATED_OPERATIONS`)
 * — the agent-native proof that a delegated agent, not just the founding sponsor, can carry a run
 * through the two gated steps that actually spend real work.
 *
 * Emits one JSON transcript to stdout (and writes the same document to
 * `<workspace-root>/transcript.json`): every command's argv/exitCode/envelope, plus a summary
 * block (record digests, per-arm headline numbers from the claim package, cell outcome counts,
 * the verify result). Dependency-free: node builtins only.
 *
 * Usage: node scripts/m1-walkthrough.mjs
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliBinPath = join(packageRoot, "dist", "cli", "bin.js");
const STEP_TIMEOUT_MS = 180_000;

/** Prints a clear, prefixed error message and terminates immediately with exit code 1 — no
 * exception unwinding, no stack-trace noise burying the actual failure. */
function fatal(message) {
  console.error(`m1-walkthrough: FATAL: ${message}`);
  process.exit(1);
}

/** Unconditionally clean-rebuilds the package's `dist/` exactly the way `scripts/build.mjs`
 * does (rm + tsc), so the transcript can never be generated against a stale build. Evidence
 * honesty over speed: a few seconds of tsc is the price of the transcript actually reflecting
 * the source tree it claims to. Needs nothing beyond `node` and installed `node_modules`. */
async function ensureBuilt() {
  console.error("m1-walkthrough: clean-rebuilding dist/ so evidence reflects current src/ ...");
  await rm(join(packageRoot, "dist"), { recursive: true, force: true });
  const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fatal(`build failed (exit ${String(result.status)}) — run "yarn build" manually and inspect the error`);
  }
  if (!existsSync(cliBinPath)) {
    fatal(`build reported success but ${cliBinPath} still does not exist`);
  }
}

/**
 * Runs one CLI invocation as a real child process. `argv` is exactly what a user would type after
 * `benchmark-product` (verb words, then flags) — `--json` is appended by the caller (`step`,
 * below), never assumed here, so this function stays a faithful raw-process wrapper.
 */
function runCli(argv) {
  const result = spawnSync(process.execPath, [cliBinPath, ...argv], {
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    fatal(`spawning "benchmark-product ${argv.join(" ")}" failed: ${result.error.message}`);
  }
  if (result.signal !== null && result.signal !== undefined) {
    fatal(
      `"benchmark-product ${argv.join(" ")}" was killed by signal ${result.signal} `
        + `(likely the ${STEP_TIMEOUT_MS}ms per-step timeout)\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const commands = [];

/**
 * Runs one labeled CLI step, appends `--json`, records it into `commands`, and asserts the
 * `{ok:true}` envelope. Returns `envelope.result` on success; throws (via `fatal`) with the full
 * argv/exitCode/stdout/stderr on any failure — an unparseable stdout, a nonzero exit, or an
 * `{ok:false}` envelope all count as failure here, since a walking-skeleton harness that swallowed
 * any of those would prove nothing.
 */
function step(label, argv) {
  const fullArgv = [...argv, "--json"];
  const { exitCode, stdout, stderr } = runCli(fullArgv);

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (cause) {
    commands.push({ label, argv: fullArgv, exitCode, stdout, stderr, envelope: null });
    fatal(
      `step "${label}" ("benchmark-product ${fullArgv.join(" ")}") did not print a parseable JSON envelope `
        + `(exit ${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}\ncause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  commands.push({ label, argv: fullArgv, exitCode, envelope });

  if (exitCode !== 0 || envelope.ok !== true) {
    fatal(
      `step "${label}" ("benchmark-product ${fullArgv.join(" ")}") did not succeed `
        + `(exit ${exitCode}, ok=${String(envelope.ok)}).\nenvelope: ${JSON.stringify(envelope, null, 2)}\nstderr: ${stderr}`,
    );
  }

  console.error(`m1-walkthrough: ${label} -> ok (exit ${exitCode})`);
  return envelope.result;
}

async function main() {
  await ensureBuilt();

  const root = mkdtempSync(join(tmpdir(), "bp14-m1-walkthrough-"));
  const workspaceDir = join(root, "workspace");
  const transcriptPath = join(root, "transcript.json");

  const sponsor = "sponsor-1";
  const delegatedAgent = "delegated-agent-1";
  const draftId = "m1-walkthrough";

  console.error(`m1-walkthrough: workspace root ${root}`);

  // ── 1. init ──────────────────────────────────────────────────────────────────────────────
  step("init", ["init", "--workspace", workspaceDir, "--principal", sponsor]);

  // ── 2. authority show (founding sponsor holds every gated grant) ───────────────────────────
  const initialAuthority = step("authority show", ["authority", "show", "--workspace", workspaceDir, "--principal", sponsor]);

  // ── 3. draft create ──────────────────────────────────────────────────────────────────────
  step("draft create", [
    "draft", "create",
    "--workspace", workspaceDir, "--principal", sponsor,
    "--id", draftId, "--name", "M1 walkthrough",
    "--description", "BP-14 cold-start walking-skeleton evidence run",
  ]);

  // ── 4. sample init ───────────────────────────────────────────────────────────────────────
  const sample = step("sample init", ["sample", "init", "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId]);

  // ── 5-6. arm add x2 — the bundled sample's two real pinnings ───────────────────────────────
  step("arm add baseline", [
    "arm", "add",
    "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId,
    "--arm", "baseline",
    "--pinning", JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } }),
  ]);
  step("arm add sample-uniform", [
    "arm", "add",
    "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId,
    "--arm", "sample-uniform",
    "--pinning", JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } }),
  ]);

  // ── 7. inspect ───────────────────────────────────────────────────────────────────────────
  step("inspect", ["inspect", "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId]);

  // ── 8. authority grant — the delegated agent, scoped to ONLY lock + launch (the agent-native
  //      proof: not the founding sponsor's blanket grant) ────────────────────────────────────
  step("authority grant delegated-agent", [
    "authority", "grant",
    "--workspace", workspaceDir, "--principal", sponsor,
    "--grantee", delegatedAgent, "--role", "delegated-agent", "--operations", "lock,launch",
  ]);

  // ── 9. quote ─────────────────────────────────────────────────────────────────────────────
  step("quote", ["quote", "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId]);

  // ── 10. lock — AS THE DELEGATED AGENT ───────────────────────────────────────────────────────
  const lock = step("lock (as delegated agent)", ["lock", "--workspace", workspaceDir, "--principal", delegatedAgent, "--draft", draftId]);

  // ── 11. launch — AS THE DELEGATED AGENT, real venue, real subprocesses ─────────────────────
  step("launch (as delegated agent)", ["launch", "--workspace", workspaceDir, "--principal", delegatedAgent, "--draft", draftId]);

  // ── 12. status ───────────────────────────────────────────────────────────────────────────
  const status = step("status", ["status", "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId]);

  // ── 13. collect ──────────────────────────────────────────────────────────────────────────
  const collect = step("collect", ["collect", "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId]);

  // ── 14. results ──────────────────────────────────────────────────────────────────────────
  step("results", ["results", "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId]);

  // ── 15. report (gated; the founding sponsor holds the "report" grant by default) ───────────
  const report = step("report", ["report", "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId]);

  // ── 16. verify ───────────────────────────────────────────────────────────────────────────
  const verify = step("verify", ["verify", "--workspace", workspaceDir, "--principal", sponsor, "--draft", draftId]);

  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

  const summary = {
    package: `${packageJson.name}@${packageJson.version}`,
    workspaceDir,
    draftId,
    principals: { sponsor, delegatedAgent },
    authorityAtInit: initialAuthority.policy,
    digests: {
      benchmarkSha256: sample.benchmarkSha256,
      runSha256: lock.runSha256,
      matrixSha256: collect.matrixSha256,
      reportSha256: report.reportSha256,
      reportEnvelopeSha256: report.reportEnvelopeSha256,
    },
    preregistered: report.preregistered,
    armHeadline: report.claimPackage.headline,
    cellOutcomeCounts: status.counts,
    verify: { ok: true, checks: verify.checks },
  };

  const transcript = {
    generatedAt: new Date().toISOString(),
    package: `${packageJson.name}@${packageJson.version}`,
    workspaceDir,
    root,
    commands,
    summary,
  };

  const rendered = `${JSON.stringify(transcript, null, 2)}\n`;
  writeFileSync(transcriptPath, rendered);

  process.stdout.write(rendered);
  console.error(`m1-walkthrough: wrote transcript to ${transcriptPath}`);
}

await main();
