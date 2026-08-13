import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalVenue, type LocalVenue, type LocalVenueOptions } from "../venue/venue.js";
import { probeInspectSelection, type InspectHostBinding } from "./inspect/host.js";
import { probeInspectOciSelection } from "./inspect/oci.js";
import type {
  InspectArmConfiguration,
  InspectRunOptions,
  InspectSelectionManifest,
} from "./inspect/manifest.js";
import type { EvaluationRuntimeBinding } from "../domain/draft.js";
import type { Demo1ClaudeRuntimeBinding } from "../venue/demo1-claude.js";

interface InspectRuntimeSelectionBase {
  readonly projectDir: string;
  readonly taskReference: string;
  readonly taskArgs?: Readonly<Record<string, unknown>>;
  readonly arms: readonly InspectArmConfiguration[];
  readonly scorer: { readonly name: string; readonly passValue: string | number | boolean | null };
  readonly runOptions?: InspectRunOptions;
}

export type InspectRuntimeSelectionRequest = InspectRuntimeSelectionBase & ({
  readonly execution?: "local-python";
  readonly pythonPath: string;
} | {
  readonly execution: "oci";
  readonly dockerPath: string;
  readonly imageDigest: string;
  readonly datasetCacheDir: string;
  readonly runOptions: InspectRunOptions & { readonly sampleId: string | number };
});

export interface InspectRuntimeSelectionResolution {
  readonly manifest: InspectSelectionManifest;
  readonly binding: InspectHostBinding;
}

/** Process-owning boundary. Product operations carry state; the injected host owns execution. */
export interface BenchmarkRuntimeHost {
  resolveInspectSelection(input: InspectRuntimeSelectionRequest, signal?: AbortSignal): Promise<InspectRuntimeSelectionResolution>;
  createVenue(
    binding: EvaluationRuntimeBinding | undefined,
    options: Omit<LocalVenueOptions, "evaluationRuntime">,
  ): LocalVenue;
}

export interface OpenAIHostConnection {
  /** Return a host-owned key file mount. The product validates metadata but never reads bytes. */
  keyFilePath(workspaceDir: string): string | undefined;
  /** TEST ONLY: a sanitized OpenAI Responses body used to prove the native Inspect transcript
   * path without network or credentials. Production CLI/web bootstrap never supplies this. */
  responseFixturePathForTesting?(workspaceDir: string): string | undefined;
}

export interface BenchmarkRuntimeHostOptions {
  readonly openAI?: OpenAIHostConnection;
  readonly repositoryRoot?: string;
  /** Explicit real Claude Code deployment used by Demo-1 repository-work arms. */
  readonly demo1ClaudeRuntime?: Demo1ClaudeRuntimeBinding;
}

function inside(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function createOpenAIConnectionDescriptor(
  connection: OpenAIHostConnection | undefined,
  workspaceDir: string,
  repositoryRoot: string,
): { readonly path?: string; readonly cleanup: () => void } {
  const candidateInput = connection?.keyFilePath(workspaceDir)?.trim();
  if (candidateInput === undefined || candidateInput === "") return { cleanup() {} };
  if (!isAbsolute(candidateInput)) throw new TypeError("BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE must be absolute");
  const inputStat = lstatSync(candidateInput);
  if (!inputStat.isFile() || inputStat.isSymbolicLink()) {
    throw new TypeError("OpenAI credential mount must be a regular, non-symlink file");
  }
  const candidate = realpathSync(candidateInput);
  const stat = lstatSync(candidate);
  if ((stat.mode & 0o400) === 0 || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) {
    throw new TypeError("OpenAI credential mount must be owned by this user and inaccessible to group/other users");
  }
  // Preview constructs its isolated scratch root lazily after venue creation, so containment
  // validation must not require that root to exist yet.
  const workspace = resolve(workspaceDir);
  if (inside(candidate, workspace) || inside(candidate, repositoryRoot)) {
    throw new TypeError("OpenAI credential mount must be outside the product workspace and repository");
  }
  const responseFixture = connection?.responseFixturePathForTesting?.(workspaceDir)?.trim();
  let responseFixtureEntry: Record<string, unknown> = {};
  if (responseFixture !== undefined && responseFixture !== "") {
    if (!isAbsolute(responseFixture)) throw new TypeError("test broker response fixture path must be absolute");
    const responseInputStat = lstatSync(responseFixture);
    if (!responseInputStat.isFile() || responseInputStat.isSymbolicLink()) {
      throw new TypeError("test broker response fixture must be a regular, non-symlink file");
    }
    const canonicalResponseFixture = realpathSync(responseFixture);
    const responseStat = lstatSync(canonicalResponseFixture);
    responseFixtureEntry = {
      testResponseFixture: canonicalResponseFixture,
      testResponseMetadata: {
        dev: responseStat.dev,
        ino: responseStat.ino,
        mode: responseStat.mode & 0o777,
        size: responseStat.size,
        uid: responseStat.uid,
      },
    };
  }
  const directory = mkdtempSync(join(tmpdir(), "jinn-benchmark-host-connection-"));
  const path = join(directory, "connection.json");
  writeFileSync(path, JSON.stringify({
    schema: "jinn.network/benchmark-product/host-connection/1",
    openAIKeyFile: candidate,
    metadata: { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, size: stat.size, uid: stat.uid },
    ...responseFixtureEntry,
  }), { encoding: "utf8", mode: 0o600 });
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export function createDefaultBenchmarkRuntimeHost(hostOptions: BenchmarkRuntimeHostOptions = {}): BenchmarkRuntimeHost {
  const repositoryRoot = realpathSync(hostOptions.repositoryRoot ?? fileURLToPath(new URL("../../../../..", import.meta.url)));
  return {
    async resolveInspectSelection(input, signal) {
      if (input.execution === "oci") {
        return probeInspectOciSelection({
          dockerPath: resolve(input.dockerPath),
          imageDigest: input.imageDigest,
          projectDir: resolve(input.projectDir),
          datasetCacheDir: resolve(input.datasetCacheDir),
          taskReference: input.taskReference,
          taskArgs: input.taskArgs,
          arms: input.arms,
          scorer: input.scorer,
          runOptions: input.runOptions,
        }, signal);
      }
      const binding = {
        kind: "local-python" as const,
        pythonPath: resolve(input.pythonPath),
        projectDir: resolve(input.projectDir),
      };
      return {
        manifest: await probeInspectSelection({
          ...binding,
          taskReference: input.taskReference,
          taskArgs: input.taskArgs,
          arms: input.arms,
          scorer: input.scorer,
          runOptions: input.runOptions,
        }),
        binding,
      };
    },
    createVenue(binding, venueOptions) {
      const descriptor = binding?.adapterId === "inspect"
        ? createOpenAIConnectionDescriptor(hostOptions.openAI, venueOptions.workspaceDir, repositoryRoot)
        : { cleanup() {} };
      try {
        const venue = createLocalVenue({
          ...venueOptions,
          ...(hostOptions.demo1ClaudeRuntime === undefined
            ? {}
            : { demo1ClaudeRuntime: hostOptions.demo1ClaudeRuntime }),
          ...(binding === undefined ? {} : { evaluationRuntime: binding }),
          ...(descriptor.path === undefined ? {} : { inspectHostConnectionDescriptor: descriptor.path }),
        });
        return {
          ...venue,
          async shutdown() {
            try {
              await venue.shutdown();
            } finally {
              descriptor.cleanup();
            }
          },
        };
      } catch (cause) {
        descriptor.cleanup();
        throw cause;
      }
    },
  };
}
