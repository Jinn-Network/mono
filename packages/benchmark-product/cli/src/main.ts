import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createDefaultBenchmarkRuntimeHost,
  PRODUCT_VERSION,
  runCli as runCoreCli,
  USAGE as CORE_USAGE,
  type CliResult,
} from "@colophon-claims/core";
import { runSampleLifecycle, SAMPLE_LIFECYCLE_MODES, type SampleLifecycleEvent } from "@colophon-claims/core/sample-lifecycle";
import { BUNDLE_FORMAT } from "@colophon-claims/verify";
import { createVerifiedBundleViewer } from "./viewer.js";
import { startLocalWorkspaceApp } from "./local-app.js";
import {
  assertQualifiedRuntime,
  readPackagedBuildMetadata,
  type ColophonBuildMetadata,
  type RuntimeTarget,
} from "./build-metadata.js";

export const USAGE = `Colophon — Publish benchmark claims people can check.

Primary commands:
  colophon                         Run the bundled sample and open its verified local viewer
  colophon demo [--output <dir>] [--no-open] [--json]
  colophon open --bundle <dir> [--port <n>] [--no-browser]
  colophon open [--workspace <dir>] [--port <n>] [--no-browser]
  colophon import swebench ...     Import your own SWE-bench tasks
  colophon bundle verify ...       Verify through the full product
  colophon help --advanced         Show the explicit lifecycle commands

No account, API key, funds, or Docker are needed for the bundled sample.
`;

function result(exitCode: number, stdout = "", stderr = ""): CliResult {
  return { exitCode, stdout, stderr };
}

class TopLevelInvocationError extends Error {
  readonly exitCode = 2;
}

function validateTopLevelOptions(
  argv: readonly string[],
  allowed: { readonly boolean?: readonly string[]; readonly value?: readonly string[] },
): void {
  const booleanFlags = new Set(allowed.boolean ?? []);
  const valueFlags = new Set(allowed.value ?? []);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--") || token === "--") {
      throw new TopLevelInvocationError(`unexpected argument "${token}"`);
    }
    const name = token.slice(2);
    if (name.includes("=")) {
      throw new TopLevelInvocationError(`use --${name.slice(0, name.indexOf("="))} followed by its value`);
    }
    if (!booleanFlags.has(name) && !valueFlags.has(name)) {
      throw new TopLevelInvocationError(`unknown option --${name}`);
    }
    if (seen.has(name)) throw new TopLevelInvocationError(`option --${name} may be supplied only once`);
    seen.add(name);
    if (valueFlags.has(name)) {
      const found = argv[index + 1];
      if (found === undefined || found.startsWith("--")) {
        throw new TopLevelInvocationError(`--${name} requires a value`);
      }
      index += 1;
    }
  }
}

function renderTopLevelFailure(cause: unknown, json: boolean): CliResult {
  const message = cause instanceof Error ? cause.message : String(cause);
  const exitCode = cause instanceof TopLevelInvocationError ? 2 : 1;
  if (json) {
    return result(exitCode, `${JSON.stringify({ ok: false, error: { code: exitCode === 2 ? "invalid-invocation" : "environment", detail: message } })}\n`);
  }
  const prefix = exitCode === 2 ? "Colophon invocation was not accepted" : "Colophon could not start";
  return result(exitCode, "", `${prefix}: ${message}\n${exitCode === 2 ? "Run colophon --help to see the supported commands.\n" : ""}`);
}

function value(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(`--${flag}`);
  if (index < 0) return undefined;
  const found = argv[index + 1];
  if (found === undefined || found.startsWith("--")) throw new TypeError(`--${flag} requires a value`);
  return found;
}

function has(argv: readonly string[], flag: string): boolean {
  return argv.includes(`--${flag}`);
}

function defaultOutput(cwd: string, now: Date): string {
  const timestamp = now.toISOString().replaceAll(":", "").replaceAll("-", "").replace(".000Z", "Z");
  return join(cwd, `colophon-quickstart-${timestamp}-${randomBytes(3).toString("hex")}`);
}

export interface QuickstartReceipt {
  readonly kind: "colophon-quickstart-receipt/1";
  readonly colophonVersion: string;
  readonly completedAt: string;
  readonly runtime: string;
  readonly platform: string;
  readonly architecture: string;
  readonly bundlePath: string;
  readonly bundleIdentity: string;
  readonly bundleFormat: typeof BUNDLE_FORMAT;
  readonly checks: readonly string[];
  readonly sourceCommit: string;
}

export function writeQuickstartCompanions(
  outputRoot: string,
  bundlePath: string,
  bundleIdentity: string,
  checks: readonly string[],
  completedAt: Date,
  buildMetadata: ColophonBuildMetadata = readPackagedBuildMetadata(),
): QuickstartReceipt {
  const receipt: QuickstartReceipt = {
    kind: "colophon-quickstart-receipt/1",
    colophonVersion: PRODUCT_VERSION,
    completedAt: completedAt.toISOString(),
    runtime: `node@${process.versions.node}`,
    platform: process.platform,
    architecture: process.arch,
    bundlePath,
    bundleIdentity: `sha256:${bundleIdentity}`,
    bundleFormat: BUNDLE_FORMAT,
    checks: [...checks],
    sourceCommit: buildMetadata.sourceCommit,
  };
  writeFileSync(join(outputRoot, "quickstart-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(join(outputRoot, "NEXT-STEPS.md"), `# Your Colophon sample\n\nThe bundle in \`./bundle\` passed all six verification checks. Nothing was uploaded.\n\nVerify it again without the full product:\n\n\`\`\`sh\nnpx @colophon-claims/verify@1 ./bundle\n\`\`\`\n\nUse your own work:\n\n\`\`\`sh\ncolophon open\n\`\`\`\n\nReal agent arms use credentials you explicitly grant and may make paid provider calls. Colophon shows that boundary before launch.\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}

export function browserCommand(url: string, platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export async function openBrowser(url: string): Promise<void> {
  const invocation = browserCommand(url);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, { detached: true, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

interface OpenLocalSurface {
  readonly url: string;
  close(): Promise<void>;
}

async function keepViewerOpen(
  viewer: OpenLocalSurface,
  browser: boolean,
  callbacks: { readonly ready?: (url: string) => void; readonly warning?: (message: string) => void } = {},
): Promise<CliResult> {
  callbacks.ready?.(viewer.url);
  if (browser) {
    try {
      await openBrowser(viewer.url);
    } catch (cause) {
      callbacks.warning?.(`Could not open a browser: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const visibleUrl = viewer.url;
  await new Promise<void>((resolvePromise) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await viewer.close();
  return result(0, `Viewer: ${visibleUrl}\nStopped the viewer; bundle files were retained.\n`);
}

async function runDemo(
  argv: readonly string[],
  cwd: string,
  now: Date,
  progress: (line: string) => void,
  interactive: boolean,
  agentDataDir?: string,
  suppliedBuildMetadata?: ColophonBuildMetadata,
  runtimeTarget?: RuntimeTarget,
): Promise<CliResult> {
  const json = has(argv, "json");
  const noOpen = has(argv, "no-open") || json || !interactive;
  const outputRoot = resolve(cwd, value(argv, "output") ?? defaultOutput(cwd, now));
  const events: SampleLifecycleEvent[] = [];
  try {
    const buildMetadata = suppliedBuildMetadata ?? readPackagedBuildMetadata();
    assertQualifiedRuntime(buildMetadata, runtimeTarget);
    if (!json) progress("No account, API key, funds, or Docker are needed. Nothing will be uploaded.");
    const evidence = runSampleLifecycle({
      mode: SAMPLE_LIFECYCLE_MODES.PRODUCT_DEMO,
      outputRoot,
      prepareBuild: () => {},
      onProgress: (event) => {
        events.push(event);
        if (!json && event.type === "progress" && event.message !== undefined) progress(event.message);
      },
    });
    writeQuickstartCompanions(
      evidence.output.root,
      evidence.output.bundle,
      evidence.digests.bundleIdentity,
      evidence.portableChecks,
      now,
      buildMetadata,
    );
    if (json) return result(0, `${JSON.stringify({ ok: true, result: evidence })}\n`);
    const answer = `Published locally; nothing was uploaded.\nBundle: ${evidence.output.bundle}\nReceipt: ${join(evidence.output.root, "quickstart-receipt.json")}\nIdentity: sha256:${evidence.digests.bundleIdentity}\nVerified: ${evidence.portableChecks.length} of 6 checks passed\nComplete comparison; no comparative winner stated.\n`;
    if (noOpen) return result(0, answer);
    const viewer = await createVerifiedBundleViewer(evidence.output.bundle, 0, {
      ...(agentDataDir === undefined ? {} : {
        startWorkspace: () => startLocalWorkspaceApp({
          workspaceDir: resolve(cwd, "colophon-workspace"),
          agentDataDir,
        }),
      }),
    });
    progress(`${answer}Viewer: ${viewer.url}`);
    return keepViewerOpen(viewer, true, { warning: progress });
  } catch (cause) {
    const exitCode = typeof (cause as { exitCode?: unknown })?.exitCode === "number" ? (cause as { exitCode: number }).exitCode : 1;
    const message = cause instanceof Error ? cause.message : String(cause);
    return json
      ? result(exitCode, `${JSON.stringify({ ok: false, error: { code: exitCode === 2 ? "invalid-invocation" : "demo-failed", detail: message } })}\n`)
      : result(exitCode, "", `Colophon sample failed: ${message}\n`);
  }
}

async function runOpen(
  argv: readonly string[],
  cwd: string,
  agentDataDir: string | undefined,
  progress: (line: string) => void,
): Promise<CliResult> {
  const bundle = value(argv, "bundle");
  const portRaw = value(argv, "port");
  const port = portRaw === undefined ? 0 : Number(portRaw);
  try {
    if (bundle === undefined) {
      if (agentDataDir === undefined) {
        return result(1, "", "Could not open the local workspace: Colophon needs an absolute product data directory for agent profiles. Set COLOPHON_DATA_HOME to an absolute path and try again.\n");
      }
      const workspace = resolve(cwd, value(argv, "workspace") ?? "colophon-workspace");
      const app = await startLocalWorkspaceApp({ workspaceDir: workspace, agentDataDir, port });
      return keepViewerOpen(app, !has(argv, "no-browser"), {
        ready: (url) => progress(`Local workspace: ${url}`),
        warning: progress,
      });
    }
    const viewer = await createVerifiedBundleViewer(resolve(cwd, bundle), port, {
      ...(agentDataDir === undefined ? {} : {
        startWorkspace: () => startLocalWorkspaceApp({
          workspaceDir: resolve(cwd, value(argv, "workspace") ?? "colophon-workspace"),
          agentDataDir,
        }),
      }),
    });
    return keepViewerOpen(viewer, !has(argv, "no-browser"), {
      ready: (url) => progress(`Viewer: ${url}`),
      warning: progress,
    });
  } catch (cause) {
    return result(1, "", `Could not open the local surface: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }
}

export interface ColophonCliContext {
  readonly cwd: string;
  readonly now: () => Date;
  readonly progress: (line: string) => void;
  /** The process has an attached human terminal and may open a long-lived viewer. */
  readonly interactive?: boolean;
  /** Explicit Colophon-owned OS data directory; never a Claude/Codex home. */
  readonly agentDataDir?: string;
  /** Packaged build evidence; injectable only for hermetic tests. */
  readonly buildMetadata?: ColophonBuildMetadata;
  /** Found operating-system target; injectable only for hermetic tests. */
  readonly runtimeTarget?: RuntimeTarget;
}

export async function runColophonCli(argv: readonly string[], context: ColophonCliContext): Promise<CliResult> {
  const json = argv.includes("--json");
  try {
    // Help is side-effect free even when it follows a command that normally runs work.
    if (argv.includes("--help")) return result(0, USAGE);
    if (argv.length === 0) return runDemo([], context.cwd, context.now(), context.progress, context.interactive ?? false, context.agentDataDir, context.buildMetadata, context.runtimeTarget);
    if (argv[0] === "demo") {
      const options = argv.slice(1);
      validateTopLevelOptions(options, { boolean: ["no-open", "json"], value: ["output"] });
      return runDemo(options, context.cwd, context.now(), context.progress, context.interactive ?? false, context.agentDataDir, context.buildMetadata, context.runtimeTarget);
    }
    if (argv[0] === "open") {
      const options = argv.slice(1);
      validateTopLevelOptions(options, { boolean: ["no-browser"], value: ["bundle", "workspace", "port"] });
      return runOpen(options, context.cwd, context.agentDataDir, context.progress);
    }
    if (argv[0] === "help") {
      const options = argv.slice(1);
      validateTopLevelOptions(options, { boolean: ["advanced"] });
      return result(0, has(options, "advanced") ? CORE_USAGE : USAGE);
    }

    const runtimeHost = createDefaultBenchmarkRuntimeHost({
      openAI: { keyFilePath: () => process.env.BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE },
      agentDataDir: context.agentDataDir,
    });
    return runCoreCli(argv, {
      cwd: context.cwd,
      clock: () => context.now().toISOString(),
      runtimeHost,
      agentDataDir: context.agentDataDir,
      progress: context.progress,
    });
  } catch (cause) {
    return renderTopLevelFailure(cause, json);
  }
}
