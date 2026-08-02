// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

const BANNED = [
  // Each entry: the phrase, and the qualification that makes it legal where it appears.
  { pattern: /\bun-?gameable\b/i, allow: /never|not|cannot|no claim/i },
  { pattern: /\bguarantees?\b/i, allow: /does not|never|no |not a /i },
  { pattern: /\bdeterministic\b/i, allow: /deterministic-process|by construction \(same sealed|script|replay/i },
  { pattern: /\bverified\b/i, allow: /verified composite|verified environment record|closed-reproducible/i },
  { pattern: /\bsafe\b/i, allow: /never|not|no claim|safety constraint|safetyConstraints/i },
  { pattern: /authenticated against mainnet/i, allow: /never|not/i },
];

function sourceAndDocFiles(): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith("bounded-claims.test.ts")) continue;
      if (name.endsWith(".ts") || name.endsWith(".md")) out.push(path);
    }
  };
  walk(packageRoot);
  return out;
}

describe("bounded claims", () => {
  it("makes no unqualified claim this family cannot support", () => {
    const offenders = sourceAndDocFiles().flatMap((file) => {
      const lines = readFileSync(file, "utf8").split("\n");
      return lines.flatMap((line, index) => BANNED
        .filter(({ pattern, allow }) => pattern.test(line) && !allow.test(line))
        .map(({ pattern }) => `${file}:${index + 1} -> ${String(pattern)} :: ${line.trim()}`));
    });
    expect(offenders).toStrictEqual([]);
  });

  it("states the admission bound in the README, in so many words", () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    expect(readme).toMatch(/proves nothing about non-gameability/i);
    expect(readme).toMatch(/the verdict grades the script, not the trajectory/i);
    expect(readme).toMatch(/mitigation, not a guarantee/i);
  });

  it("uses no emoji anywhere in the package", () => {
    const offenders = sourceAndDocFiles().filter((file) =>
      /\p{Extended_Pictographic}/u.test(readFileSync(file, "utf8")));
    expect(offenders).toStrictEqual([]);
  });
});
