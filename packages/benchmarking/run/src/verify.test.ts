import { buildMiniatureAssemblyPorts } from "@jinn-network/benchmarking-testing";
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { assembleMatrix } from "./assemble.js";
import { verifyMatrix } from "./verify.js";

describe("verifyMatrix (§10.1 op 6)", () => {
  test("re-derivation matches the kit miniature Matrix with exact bytes", async () => {
    const { bench, run, ports, procedure, expectedBytes } = await buildMiniatureAssemblyPorts();
    const assembled = await assembleMatrix(bench, run, ports, procedure);
    expect(assembled.bytes).toEqual(expectedBytes);
    const ok = await verifyMatrix(
      parseMatrix(expectedBytes),
      bench,
      run,
      ports,
      procedure,
      expectedBytes,
    );
    expect(ok).toEqual({ ok: true });
  });

  test("rejects soft path: missing matrix bytes", async () => {
    const { bench, run, ports, procedure, expectedBytes } = await buildMiniatureAssemblyPorts();
    const matrix = parseMatrix(expectedBytes);
    const result = await verifyMatrix(
      matrix,
      bench,
      run,
      ports,
      procedure,
      undefined as unknown as Uint8Array,
    );
    expect(result).toMatchObject({ ok: false, check: "matrix-rederivation" });
  });

  test("rejects mutated matrix bytes", async () => {
    const { bench, run, ports, procedure, expectedBytes } = await buildMiniatureAssemblyPorts();
    const mutated = new Uint8Array(expectedBytes);
    mutated[0] = (mutated[0]! + 1) % 256;
    const result = await verifyMatrix(
      parseMatrix(expectedBytes),
      bench,
      run,
      ports,
      procedure,
      mutated,
    );
    expect(result).toMatchObject({ ok: false, check: "matrix-rederivation" });
  });

  test("signature port failure surfaces matrix-authority", async () => {
    const { bench, run, ports, procedure, expectedBytes } = await buildMiniatureAssemblyPorts();
    const result = await verifyMatrix(
      parseMatrix(expectedBytes),
      bench,
      run,
      {
        ...ports,
        verifySignatures: {
          async verifyMatrixAuthority() {
            return { ok: false, detail: "bad sig" };
          },
        },
      },
      procedure,
      expectedBytes,
    );
    expect(result).toEqual({ ok: false, check: "matrix-authority", detail: "bad sig" });
  });
});
