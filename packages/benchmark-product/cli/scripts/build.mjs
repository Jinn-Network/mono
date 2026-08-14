import { spawn } from "node:child_process";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "..", "web");
const localWebRoot = join(root, "dist", "local-web");
const standaloneWebRoot = join(localWebRoot, "packages", "benchmark-product", "web");
const DEFAULT_QUALIFIED_TARGETS = ["darwin/arm64", "linux/x64"];

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${String(code)}`)));
  });
}

async function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(chunks).toString("utf8").trim())
      : reject(new Error(`${command} exited with ${String(code)}`)));
  });
}

async function writeBuildMetadata() {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const sourceCommit = (process.env.COLOPHON_SOURCE_COMMIT?.trim() || await capture("git", ["rev-parse", "HEAD"], root)).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("COLOPHON_SOURCE_COMMIT must be the immutable 40-character Git commit used to build this package.");
  }
  // v1 qualification is evidence, not an inference from whichever machine ran `npm pack`.
  // Expanding this constant requires a matching cold-machine proof for the new target.
  const qualifiedTargets = [...DEFAULT_QUALIFIED_TARGETS];
  await writeFile(join(root, "dist", "build-metadata.json"), `${JSON.stringify({
    kind: "colophon-package-build/1",
    packageVersion: manifest.version,
    sourceCommit,
    qualifiedTargets,
  }, null, 2)}\n`);
}

async function required(path, description) {
  try {
    const information = await stat(path);
    if (!information.isFile() && !information.isDirectory()) throw new Error("not a file or directory");
  } catch {
    throw new Error(`Private web build did not produce ${description} (${path}). The CLI cannot be packed without the local UI.`);
  }
}

async function buildPrivateWeb() {
  // `web` is private source/build input. Its standalone output, static assets,
  // and public assets are copied into the CLI tarball; no web package is
  // declared as an installable runtime dependency.
  // `npm_execpath` is a shell shim under Corepack on some supported hosts, so
  // invoking it through Node is not portable. `packageManager` pins Yarn and
  // the normal executable preserves that contract.
  await run("yarn", ["--cwd", webRoot, "build"], root);
  const standalone = join(webRoot, ".next", "standalone");
  const standaloneApp = join(standalone, "packages", "benchmark-product", "web");
  await required(join(standaloneApp, ".next", "BUILD_ID"), "the Next standalone BUILD_ID");
  await required(join(standaloneApp, "server.js"), "the Next standalone server");
  await required(join(webRoot, ".next", "static"), "the Next static assets");
  await required(join(webRoot, "local-server.mjs"), "the loopback local server");
  // npm excludes nested node_modules from the package tarball. Excluding them
  // here avoids a slow, misleading copy; all runtime dependencies are pinned
  // in the CLI manifest and resolve from the installed package root.
  await cp(standalone, localWebRoot, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules",
  });
  // The trace root is the mono root, so keep its directory topology intact:
  // traced @colophon-claims/core and verifier symlinks are relative to this
  // web directory and would break if the app were flattened.
  await cp(join(webRoot, ".next", "static"), join(standaloneWebRoot, ".next", "static"), { recursive: true });
  await cp(join(webRoot, "public"), join(standaloneWebRoot, "public"), { recursive: true });
  await cp(join(webRoot, "local-server.mjs"), join(standaloneWebRoot, "local-server.mjs"));
}

await rm(join(root, "dist"), { recursive: true, force: true });
await run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], root);
await writeBuildMetadata();
await buildPrivateWeb();
