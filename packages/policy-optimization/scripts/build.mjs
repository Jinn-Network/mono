import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { rm } from "node:fs/promises";
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

await chmod(join(dist, "cli", "bin.js"), 0o755);
