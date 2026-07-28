import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-retrieval-"));
const archive = join(temporaryRoot, "evidence-retrieval.tgz");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

try {
  await run("yarn", ["pack", "--out", archive], {
    cwd: new URL("..", import.meta.url),
  });
  await run("tar", [
    "-tzf",
    archive,
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts",
  ]);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
