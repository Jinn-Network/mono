// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "linux") process.exit(0);

const output = join(root, "dist", "native", "jinn-attempt-shim");
const source = join(root, "native", "jinn-attempt-shim.c");
if (!existsSync(source)) throw new Error("Linux native custody source is missing");
await mkdir(dirname(output), { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn(process.env.CC ?? "cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`native custody compile exited with ${code}`)));
});

if (process.env.JINN_NATIVE_CUSTODY_BUILD_TESTING === "1") {
  const testOutput = join(root, "dist", "native", "jinn-attempt-shim-test");
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.CC ?? "cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-DJINN_NATIVE_CUSTODY_TESTING", source, "-o", testOutput], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`test native custody compile exited with ${code}`)));
  });
}
