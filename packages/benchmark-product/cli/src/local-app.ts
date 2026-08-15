import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_APP_DIRECTORY = "local-web";
const LOCAL_APP_SERVER = "local-server.mjs";
const STANDALONE_WEB_PATH = ["packages", "benchmark-product", "web"] as const;
// First start from an npm cache may pay Next's one-time production boot cost.
// Keep this bounded, but do not misclassify a cold Mac as a broken package.
const READY_TIMEOUT_MS = 30_000;
const SAFE_INHERITED_ENVIRONMENT = ["PATH", "SystemRoot", "SystemDrive", "ComSpec", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const;

export interface PackagedLocalApp {
  readonly root: string;
  readonly server: string;
}

export interface LocalAppCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface LocalWorkspaceApp {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export function cliPackageRoot(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

function requiredFile(root: string, relativePath: string): void {
  const candidate = join(root, relativePath);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new Error(`Broken Colophon installation: packaged local UI is missing ${relativePath}. Reinstall this package or report the distribution version.`);
  }
}

function requiredDirectory(root: string, relativePath: string): void {
  const candidate = join(root, relativePath);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`Broken Colophon installation: packaged local UI is missing ${relativePath}. Reinstall this package or report the distribution version.`);
  }
}

function requireInstalledRuntimeDependency(packageRoot: string, dependency: string): void {
  try {
    const manifest = createRequire(join(packageRoot, "package.json")).resolve(`${dependency}/package.json`);
    if (!statSync(manifest).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Broken Colophon installation: required runtime dependency ${dependency} is missing. Reinstall this package or report the distribution version.`);
  }
}

/** Fails before a browser is opened when the private Next build was not packed. */
export function assertPackagedLocalApp(packageRoot = cliPackageRoot()): PackagedLocalApp {
  const root = join(packageRoot, "dist", LOCAL_APP_DIRECTORY, ...STANDALONE_WEB_PATH);
  requiredFile(root, LOCAL_APP_SERVER);
  requiredFile(root, ".next/BUILD_ID");
  requiredDirectory(root, ".next/static");
  // npm may hoist the pinned runtime above the CLI package. Resolve it with the
  // same Node package search used by local-server.mjs instead of assuming a
  // nested node_modules layout.
  requireInstalledRuntimeDependency(packageRoot, "next");
  requiredFile(root, "public/brand/favicon.svg");
  return { root, server: join(root, LOCAL_APP_SERVER) };
}

export function createLocalAppCapability(): string {
  return randomBytes(32).toString("base64url");
}

export function localAppLaunchUrl(port: number, capability: string): string {
  return `http://127.0.0.1:${port}/__colophon_launch?capability=${encodeURIComponent(capability)}`;
}

/**
 * The child receives only operational locale/path variables, never ambient
 * provider credentials or a caller's home/config directory. The selected
 * workspace and principal are process configuration, not browser inputs.
 */
export function localAppEnvironment(
  workspaceDir: string,
  agentDataDir: string,
  capability: string,
  port = 0,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string | undefined>> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("port must be an integer from 0 to 65535");
  const environment: Record<string, string | undefined> = {};
  for (const name of SAFE_INHERITED_ENVIRONMENT) {
    if (inherited[name] !== undefined) environment[name] = inherited[name];
  }
  environment.NODE_ENV = "production";
  environment.NEXT_TELEMETRY_DISABLED = "1";
  environment.HOSTNAME = "127.0.0.1";
  environment.PORT = String(port);
  environment.BENCHMARK_PRODUCT_WORKSPACE_DIR = workspaceDir;
  environment.BENCHMARK_PRODUCT_AGENT_DATA_DIR = agentDataDir;
  environment.BENCHMARK_PRODUCT_PRINCIPAL = "local-operator";
  environment.COLOPHON_LOCAL_APP_CAPABILITY = capability;
  return environment;
}

export function localAppCommand(
  app: PackagedLocalApp,
  workspaceDir: string,
  agentDataDir: string,
  capability: string,
  port = 0,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): LocalAppCommand {
  return {
    command: process.execPath,
    args: [app.server],
    cwd: app.root,
    environment: localAppEnvironment(workspaceDir, agentDataDir, capability, port, inherited),
  };
}

function waitForLocalApp(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      callback();
    };
    const onError = () => finish(() => reject(new Error("Could not start the local workspace.")));
    const onExit = () => finish(() => reject(new Error("The local workspace stopped before it was ready.")));
    const onMessage = (message: unknown) => {
      const ready = message as { kind?: unknown; port?: unknown };
      const port = ready.port;
      if (ready.kind !== "colophon-local-app-ready" || typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return;
      finish(() => resolvePromise(port));
    };
    const timeout = setTimeout(() => finish(() => reject(new Error("The local workspace did not become ready within 30 seconds."))), READY_TIMEOUT_MS);
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

function closeLocalApp(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

export interface StartLocalWorkspaceAppOptions {
  readonly workspaceDir: string;
  /** Non-secret Colophon OS user-data root; never sourced from HOME/XDG in the child. */
  readonly agentDataDir: string;
  readonly port?: number;
  readonly packageRoot?: string;
  readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
}

/** Starts the packaged UI on an OS-selected loopback port and returns its one-time URL. */
export async function startLocalWorkspaceApp(options: StartLocalWorkspaceAppOptions): Promise<LocalWorkspaceApp> {
  const app = assertPackagedLocalApp(options.packageRoot);
  const capability = createLocalAppCapability();
  const command = localAppCommand(app, options.workspaceDir, options.agentDataDir, capability, options.port, options.inheritedEnvironment);
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.environment,
    shell: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const port = await waitForLocalApp(child);
    return { url: localAppLaunchUrl(port, capability), port, close: () => closeLocalApp(child) };
  } catch (cause) {
    await closeLocalApp(child);
    throw cause;
  }
}
