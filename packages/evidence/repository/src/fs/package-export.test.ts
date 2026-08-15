import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("publishes the filesystem binding only through the fs subpath", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, unknown> };

  expect(manifest.exports["./fs"]).toEqual({
    import: "./dist/fs/index.js",
    types: "./dist/fs/index.d.ts",
  });
  expect(manifest.exports["."]).not.toMatchObject({
    import: expect.stringContaining("fs"),
  });
});
