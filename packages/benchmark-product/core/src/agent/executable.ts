import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentAdapter } from "./profile.js";

const CODEX_TARGETS: Readonly<Record<string, { readonly packageSuffix: string; readonly triple: string }>> = {
  "darwin/arm64": { packageSuffix: "darwin-arm64", triple: "aarch64-apple-darwin" },
  "darwin/x64": { packageSuffix: "darwin-x64", triple: "x86_64-apple-darwin" },
  "linux/arm64": { packageSuffix: "linux-arm64", triple: "aarch64-unknown-linux-musl" },
  "linux/x64": { packageSuffix: "linux-x64", triple: "x86_64-unknown-linux-musl" },
};

function executableOnPath(name: string, pathValue: string): string {
  for (const directory of pathValue.split(":").filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the explicit search path.
    }
  }
  throw new Error(`${name} was not found on PATH; supply --executable with its absolute path`);
}

function packageRootForCodexShim(shim: string): string | undefined {
  let cursor = dirname(shim);
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(cursor, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { readonly name?: unknown };
        if (parsed.name === "@openai/codex") return cursor;
      } catch {
        throw new Error("Codex package metadata is not valid JSON");
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

function resolveCodexNative(candidate: string, platform: string, arch: string): string {
  const canonical = realpathSync(candidate);
  if (basename(canonical) !== "codex.js") return canonical;
  const packageRoot = packageRootForCodexShim(canonical);
  if (packageRoot === undefined) throw new Error("Codex npm shim is not inside an identifiable @openai/codex package");
  const target = CODEX_TARGETS[`${platform}/${arch}`];
  if (target === undefined) throw new Error(`Codex native executable discovery is not qualified for ${platform}/${arch}`);
  const candidates = [
    join(packageRoot, "node_modules", "@openai", `codex-${target.packageSuffix}`, "vendor", target.triple, "bin", "codex"),
    join(packageRoot, "vendor", target.triple, "bin", "codex"),
  ];
  const native = candidates.find(existsSync);
  if (native === undefined) throw new Error("Codex npm shim has no installed native executable for this target");
  return realpathSync(native);
}

export interface DiscoverAgentExecutableOptions {
  readonly explicitPath?: string;
  readonly path?: string;
  readonly platform?: string;
  readonly arch?: string;
}

/** Resolves to the exact regular executable that Colophon will hash and launch. */
export function discoverAgentExecutable(
  adapter: AgentAdapter,
  options: DiscoverAgentExecutableOptions = {},
): string {
  const selected = options.explicitPath === undefined
    ? executableOnPath(adapter === "claude-code" ? "claude" : "codex", options.path ?? process.env.PATH ?? "")
    : resolve(options.explicitPath);
  const canonical = adapter === "codex"
    ? resolveCodexNative(selected, options.platform ?? process.platform, options.arch ?? process.arch)
    : realpathSync(selected);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${adapter} executable must resolve to a regular non-symlink file`);
  accessSync(canonical, constants.X_OK);
  return canonical;
}
