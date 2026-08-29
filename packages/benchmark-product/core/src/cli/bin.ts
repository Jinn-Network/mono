#!/usr/bin/env node

/**
 * The bin wrapper — the only file in this package that touches the process.
 *
 * Everything it does is adapt `process` to `runCli`'s injected environment
 * and back. Keeping it this short is what makes every verb testable without
 * spawning anything (mirrors `packages/policy-optimization/src/cli/bin.ts`).
 */

import { join } from "node:path";
import { runCli } from "./main.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import { captureQualifiedSubscriptionLogin } from "../agent/index.js";
import type { AgentProfile } from "../agent/index.js";

function agentDataDir(): string | undefined {
  const root = process.env.XDG_DATA_HOME ?? (process.env.HOME === undefined ? undefined : join(process.env.HOME, "Library", "Application Support"));
  return root === undefined ? undefined : join(root, "Colophon");
}

const runtimeHost = createDefaultBenchmarkRuntimeHost({
  openAI: { keyFilePath: () => process.env.BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE },
  agentDataDir: agentDataDir(),
  ...(process.stdin.isTTY && process.stdout.isTTY
    ? { subscriptionLogin: async (dataDir: string, profile: AgentProfile) => captureQualifiedSubscriptionLogin(dataDir, profile) }
    : {}),
});

// One shutdown request for the verbs that run until interrupted (`publication serve`). Listening
// unconditionally is harmless: every other verb returns without ever reading it.
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => shutdown.abort());

const result = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  clock: () => new Date().toISOString(),
  shutdownSignal: shutdown.signal,
  runtimeHost,
  agentDataDir: agentDataDir(),
  // stderr, never stdout: --json mode's stdout must stay a single machine-parseable envelope,
  // and even in human mode stdout is reserved for the verb's final rendered result.
  progress: (line) => process.stderr.write(`${line}\n`),
});

if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
