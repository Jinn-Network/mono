import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const pythonPath = process.env.JINN_INSPECT_PYTHON;
const workerPath = fileURLToPath(new URL("./worker.py", import.meta.url));
const projections = [
  { measurementName: "correct", scorerName: "correctness", passValue: "C" },
  { measurementName: "safe", scorerName: "policy", subScoreKey: "safe", passValue: true },
] as const;

function observe(samples: ReadonlyArray<Readonly<Record<string, unknown>>>) {
  const manifest = {
    scorers: [
      { name: "correctness" },
      { name: "policy" },
      { name: "diagnostic" },
    ],
    scoring: { projections },
  };
  const script = [
    "import importlib.util,json,sys",
    "from types import SimpleNamespace",
    "spec=importlib.util.spec_from_file_location('jinn_worker',sys.argv[1])",
    "worker=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(worker)",
    "manifest=json.loads(sys.argv[2])",
    "rows=json.loads(sys.argv[3])",
    "samples=[SimpleNamespace(scores={name:SimpleNamespace(value=value) for name,value in row.items()}) for row in rows]",
    "print(json.dumps(worker.project_multiple_scorer_observations(manifest,samples),sort_keys=True,separators=(',',':')))",
  ].join(";");
  const result = spawnSync(
    pythonPath!,
    ["-c", script, workerPath, JSON.stringify(manifest), JSON.stringify(samples)],
    { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as [
    Array<{ name: string; presentSamples: number; missingSamples: number; valueShapes: string[] }>,
    Array<{ measurementName: string; missingSamples: number; invalidValueSamples: number; value: boolean | null }>,
    boolean,
  ];
}

describe.skipIf(pythonPath === undefined)("Inspect worker multi-scorer observations", () => {
  test("keeps missing non-selected output in inventory without invalidating selected measurements", () => {
    const [inventory, measurements, unscorable] = observe([
      { correctness: "C", policy: { safe: true, privateDetail: "not-returned" } },
    ]);
    expect(unscorable).toBe(false);
    expect(inventory).toEqual([
      { name: "correctness", presentSamples: 1, missingSamples: 0, valueShapes: ["string"] },
      { name: "policy", presentSamples: 1, missingSamples: 0, valueShapes: ["object"] },
      { name: "diagnostic", presentSamples: 0, missingSamples: 1, valueShapes: [] },
    ]);
    expect(measurements.map(({ measurementName, value }) => ({ measurementName, value }))).toEqual([
      { measurementName: "correct", value: true },
      { measurementName: "safe", value: true },
    ]);
    expect(JSON.stringify([inventory, measurements])).not.toContain("privateDetail");
  });

  test.each([
    ["missing scorer", { correctness: "C" }, 1, 0],
    ["missing dictionary key", { correctness: "C", policy: { relevant: true } }, 1, 0],
    ["list-valued key", { correctness: "C", policy: { safe: [true] } }, 0, 1],
    ["nested object key", { correctness: "C", policy: { safe: { value: true } } }, 0, 1],
  ])("marks %s selected output unscorable", (_name, row, missing, invalid) => {
    const [, measurements, unscorable] = observe([row]);
    expect(unscorable).toBe(true);
    expect(measurements[1]).toMatchObject({ missingSamples: missing, invalidValueSamples: invalid, value: null });
  });

  test("compares expected scalar values without boolean/number coercion", () => {
    const [, measurements, unscorable] = observe([
      { correctness: "C", policy: { safe: 1 } },
    ]);
    expect(unscorable).toBe(false);
    expect(measurements[1]?.value).toBe(false);
  });

  test("uses JSON scalar types, including one numeric type, and rejects non-JSON complex values", () => {
    const script = [
      "import importlib.util,sys",
      "spec=importlib.util.spec_from_file_location('jinn_worker',sys.argv[1])",
      "worker=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(worker)",
      "assert worker.projected_scalar_equal(1.0,1)",
      "assert not worker.projected_scalar_equal(True,1)",
      "assert not worker.is_projectable_scalar((1,2))",
      "assert not worker.is_projectable_scalar(float('nan'))",
    ].join(";");
    const result = spawnSync(pythonPath!, ["-c", script, workerPath], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
