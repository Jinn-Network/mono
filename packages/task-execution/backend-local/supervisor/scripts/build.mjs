import { spawn } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageRoot, "dist");

await rm(dist, { recursive: true, force: true });

await new Promise((resolve, reject) => {
  const child = spawn("yarn", ["tsc", "-p", "tsconfig.build.json"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`TypeScript build exited with ${code}`));
  });
});

// The credential bridge is a plain ESM process entrypoint and must run before a harness without
// a TypeScript loader or dependencies that could inherit credentials.
await copyFile(join(packageRoot, "src", "credential-exec.mjs"), join(dist, "credential-exec.mjs"));

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["scripts/build-native.mjs"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`native custody build exited with ${code}`));
  });
});
