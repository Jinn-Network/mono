import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-curation-"));
const consumer = join(temporaryRoot, "consumer");

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
  const archive = join(temporaryRoot, "task-curation.tgz");
  await run("yarn", ["pack", "--out", archive], { cwd: packageRoot });
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@jinn-network/task-curation": `file:${archive}` },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-curation");
  const smokeScript = join(consumer, "smoke.mjs");
  // The installed root arrives on argv, not interpolated into the script text: no nested
  // template escaping, and the script stays readable.
  await writeFile(
    smokeScript,
    [
      'import { readFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'import { projectCuration, SATURATION_REFERENCE_BAND_RATIO } from "@jinn-network/task-curation";',
      'if (projectCuration([]).rows.length !== 0) throw new Error("empty projection is not empty");',
      'if (SATURATION_REFERENCE_BAND_RATIO.max.num !== 70) throw new Error("reference band drifted");',
      'const manifest = JSON.parse(await readFile(join(process.argv[2], "package.json"), "utf8"));',
      'const jinn = Object.keys(manifest.dependencies ?? {}).filter((n) => n.startsWith("@jinn-network/"));',
      'if (jinn.length !== 0) throw new Error("unexpected Jinn coupling: " + jinn.join(", "));',
      'console.log("Installed package imports and dependency boundary verified.");',
    ].join("\n"),
  );
  await run(process.execPath, [smokeScript, installedRoot], { cwd: consumer });

  const distFiles = await readdir(join(installedRoot, "dist"));
  if (distFiles.some((name) => name.includes(".test."))) {
    throw new Error("test output leaked into dist");
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
