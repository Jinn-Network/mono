import { expect, test } from "vitest";

test("filesystem binding is available through the repository fs subtree", async () => {
  const binding = await import("./index.js");

  expect(binding.createFilesystemEvidenceRepository).toBeTypeOf("function");
  expect(binding.FilesystemEvidenceRepository).toBeTypeOf("function");
});
