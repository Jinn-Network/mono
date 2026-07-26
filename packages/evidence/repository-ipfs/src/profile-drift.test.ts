// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const checker = join(packageRoot, "scripts", "check-profile.mjs");

test("profile checker is non-mutating and rejects golden fixture drift", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-ipfs-profile-"));
  const profileRoot = join(temporaryRoot, "profile");
  await cp(join(packageRoot, "profile"), profileRoot, { recursive: true });

  const fixturePath = join(
    profileRoot,
    "v1",
    "fixtures",
    "artifact-registration.json",
  );
  const before = await readFile(fixturePath);
  const valid = await runChecker(profileRoot);
  assert.equal(valid.code, 0, valid.stderr);
  assert.deepEqual(await readFile(fixturePath), before);

  await writeFile(
    fixturePath,
    before.toString("utf8").replace(
      "f015512203be2cf6",
      "f015512203be2cf7",
    ),
  );
  const stale = await runChecker(profileRoot);
  assert.notEqual(stale.code, 0);
  assert.match(stale.stderr, /artifact-registration\.json/u);
});

function runChecker(
  profileRoot: string,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [checker, "--profile-root", profileRoot],
      {
        cwd: packageRoot,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
