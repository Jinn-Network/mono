import { spawn } from "node:child_process";
import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageRoot, "dist");
const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

await rm(dist, { recursive: true, force: true });

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`TypeScript build exited with ${code}`));
  });
});

const runtimeAssetDir = join(dist, "runtime", "inspect");
await mkdir(runtimeAssetDir, { recursive: true });
await copyFile(join(packageRoot, "src", "runtime", "inspect", "worker.py"), join(runtimeAssetDir, "worker.py"));
await copyFile(join(packageRoot, "src", "runtime", "inspect", "Dockerfile"), join(runtimeAssetDir, "Dockerfile"));
await copyFile(join(packageRoot, "src", "runtime", "inspect", "oci-runner.mjs"), join(runtimeAssetDir, "oci-runner.mjs"));
await copyFile(join(packageRoot, "src", "runtime", "inspect", "broker.py"), join(runtimeAssetDir, "broker.py"));
await copyFile(join(packageRoot, "src", "runtime", "inspect", "model_provider.py"), join(runtimeAssetDir, "model_provider.py"));
await copyFile(join(packageRoot, "src", "runtime", "inspect", "sandbox-controller.mjs"), join(runtimeAssetDir, "sandbox-controller.mjs"));
await cp(
  join(packageRoot, "src", "runtime", "inspect", "sandbox_extension"),
  join(runtimeAssetDir, "sandbox_extension"),
  { recursive: true },
);
