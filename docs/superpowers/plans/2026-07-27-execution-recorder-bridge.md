# Execution Recorder Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a host-owned, language-neutral standard-input/output bridge that
maps versioned JSON requests directly onto the existing Execution Recorder and
proves equivalent durable evidence behavior without migrating any host.

**Architecture:** Add one sibling Evidence package,
`@jinn-network/execution-recorder-bridge`. Separate JSON wire declarations,
exact-byte decoding, Recorder dispatch and per-workspace serialization, stream
framing, and the filesystem-backed executable. The bridge has no durable state
outside Recorder workspaces and no host-specific lifecycle abstraction.

**Tech Stack:** Node.js 22, TypeScript 5.9, Yarn 4.13, Vitest 4.1,
newline-delimited JSON over standard input/output,
`@jinn-network/execution-recorder`, and
`@jinn-network/evidence-repository`.

## Global Constraints

- Implement against
  `docs/superpowers/specs/2026-07-26-execution-evidence-capture-design.md`.
- Use `jinn.execution-recorder.bridge/v1` as the only wire protocol identifier.
- Recorder methods remain the only semantic lifecycle contract.
- One bridge process has one Repository and may multiplex several workspaces.
- Serialize operations within one workspace; allow independent workspaces to
  progress concurrently.
- Standard output contains protocol responses only; diagnostics use standard
  error and never include payload bytes, credentials, sensitive paths, or stack
  traces.
- Use Node.js `>=22` and Yarn `4.13.0`.
- Follow red-green-refactor for every production behavior.
- The bridge package has production dependencies only on
  `@jinn-network/execution-recorder` and
  `@jinn-network/evidence-repository`.
- `@jinn-network/evidence-protocol` is a development-only dependency and portal
  resolution so a clean stacked-monorepo install can resolve the Recorder's
  unpublished transitive dependency. Bridge production source must not import
  it.
- Do not modify Hermes, the Jinn plugin, `EpisodeV1`, Autopilot, marketplace
  adapters, production configuration, release channels, deployment, migration,
  or cutover.

## Preflight

Work from an isolated worktree branched off the recorded Evidence integration
head `f65880c4e244e32334f0fed98bf00ff9b307e87d` on `integration/evidence-v1`, or
a descendant containing that exact commit. Put Node 22 first on `PATH` and build
the stacked prerequisites in dependency order:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

git merge-base --is-ancestor f65880c4e244e32334f0fed98bf00ff9b307e87d HEAD

for package in protocol repository execution-recorder; do
  (
    cd "packages/evidence/${package}"
    yarn install --immutable
    yarn build
  )
done
```

Expected: every command exits zero and each prerequisite has a `dist/`
directory. Do not edit those packages to make the bridge work.

## File structure

- `packages/evidence/execution-recorder-bridge/src/protocol.ts`: public wire
  envelopes, method payloads, source shapes, protocol constants, and error
  payload types.
- `packages/evidence/execution-recorder-bridge/src/wire.ts`: strict JSON-safe
  artifact-source decoding and Recorder input conversion.
- `packages/evidence/execution-recorder-bridge/src/errors.ts`: bridge-local
  stable errors and sanitized dependency-error conversion.
- `packages/evidence/execution-recorder-bridge/src/bridge.ts`: transient
  recording registry, per-workspace sequencing, and Recorder method dispatch.
- `packages/evidence/execution-recorder-bridge/src/server.ts`: concurrent
  newline-delimited JSON reader and serialized response writer.
- `packages/evidence/execution-recorder-bridge/src/cli.ts`: filesystem
  Repository startup composition and command-line validation.
- `packages/evidence/execution-recorder-bridge/src/bin.ts`: published executable
  entrypoint.
- `packages/evidence/execution-recorder-bridge/src/index.ts`: public package
  exports.
- `packages/evidence/execution-recorder-bridge/src/*.test.ts`: focused unit and
  integration tests beside their production units.
- `packages/evidence/execution-recorder-bridge/scripts/pack-smoke.mjs`: packed
  import, binary, and exact-byte child-process round trip.
- `packages/evidence/execution-recorder-bridge/README.md`: transport, privacy,
  recovery, and operator contract.
- `.github/scripts/evidence-package-inventory.test.mjs`: ninth Evidence package
  and approved dependency graph.
- `.github/scripts/evidence-source-boundaries.test.mjs`: bridge dependency
  direction and concrete-binding exception limited to CLI composition.
- `.github/scripts/evidence-packed-types.test.mjs`: packed public entrypoint
  compilation.
- `.github/workflows/evidence-ci.yml`: bridge verification after Recorder build.

---

### Task 1: Declare the package and wire protocol

**Files:**

- Create: `packages/evidence/execution-recorder-bridge/package.json`
- Create: `packages/evidence/execution-recorder-bridge/yarn.lock`
- Create: `packages/evidence/execution-recorder-bridge/.gitignore`
- Create: `packages/evidence/execution-recorder-bridge/.yarnrc.yml`
- Create: `packages/evidence/execution-recorder-bridge/tsconfig.json`
- Create: `packages/evidence/execution-recorder-bridge/tsconfig.build.json`
- Create: `packages/evidence/execution-recorder-bridge/src/protocol.test.ts`
- Create: `packages/evidence/execution-recorder-bridge/src/protocol.ts`
- Create: `packages/evidence/execution-recorder-bridge/src/index.ts`
- Modify: `.github/scripts/evidence-package-inventory.test.mjs`

**Interfaces:**

- Produces:
  `RECORDER_BRIDGE_PROTOCOL`,
  `RECORDER_BRIDGE_VERSION`,
  `COMPATIBLE_RECORDER_VERSION`,
  `RecorderBridgeRequest`,
  `RecorderBridgeResponse`,
  `RecorderBridgeTarget`,
  `WireArtifactSource`, and the seven method-specific parameter types.
- Production dependencies:
  `@jinn-network/execution-recorder@0.1.0` and
  `@jinn-network/evidence-repository@0.1.0`.
- Development-only Jinn dependency:
  `@jinn-network/evidence-protocol@0.1.0`.

- [ ] **Step 1: Make the architecture inventory expect the ninth package**

Add:

```js
['execution-recorder-bridge', '@jinn-network/execution-recorder-bridge'],
```

and approve exactly this Jinn dependency graph:

```js
['execution-recorder-bridge', {
  dependencies: [
    '@jinn-network/evidence-repository',
    '@jinn-network/execution-recorder',
  ],
  devDependencies: ['@jinn-network/evidence-protocol'],
  optionalDependencies: [],
  peerDependencies: [],
}],
```

Change the inventory assertion from eight to nine manifests.
Extend the manifest-discovery predicate so
`@jinn-network/execution-recorder-bridge` is counted explicitly alongside
`@jinn-network/execution-recorder` and `@jinn-network/attestation-issuer`;
otherwise the inventory could approve the new entry while failing to discover
the on-disk package.

- [ ] **Step 2: Run the inventory test and verify RED**

Run from the repository root:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
```

Expected: FAIL because
`packages/evidence/execution-recorder-bridge/package.json` does not exist.

- [ ] **Step 3: Add the package scaffold**

Create this manifest:

```json
{
  "name": "@jinn-network/execution-recorder-bridge",
  "version": "0.1.0",
  "description": "Language-neutral process transport for the Jinn Execution Recorder.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/evidence/execution-recorder-bridge"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "jinn-execution-recorder-bridge": "./dist/bin.js"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist/",
    "README.md"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/evidence-repository": "0.1.0",
    "@jinn-network/execution-recorder": "0.1.0"
  },
  "devDependencies": {
    "@jinn-network/evidence-protocol": "0.1.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/evidence-protocol": "portal:../protocol",
    "@jinn-network/evidence-repository": "portal:../repository",
    "@jinn-network/execution-recorder": "portal:../execution-recorder"
  }
}
```

Match sibling package configuration:

```yaml
# .yarnrc.yml
nodeLinker: node-modules
```

```text
# .gitignore
dist/
node_modules/
*.tgz
```

Use the same strict ES2022 compiler options as Execution Recorder, with
`tsconfig.build.json` excluding `src/**/*.test.ts`.

- [ ] **Step 4: Generate and prove the immutable dependency graph**

Run:

```bash
cd packages/evidence/execution-recorder-bridge
yarn install
yarn install --immutable
```

Expected: both commands exit zero. The generated `yarn.lock` resolves Protocol,
Repository, and Recorder through their declared portals; no private package is
fetched from the public registry.

- [ ] **Step 5: Write the failing protocol-shape test**

Create `src/protocol.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  COMPATIBLE_RECORDER_VERSION,
  RECORDER_BRIDGE_PROTOCOL,
  RECORDER_BRIDGE_VERSION,
  type RecorderBridgeRequest,
} from "./protocol.js";

describe("Recorder Bridge protocol", () => {
  test("declares the versioned hello request", () => {
    expect(RECORDER_BRIDGE_PROTOCOL).toBe(
      "jinn.execution-recorder.bridge/v1",
    );
    expect(RECORDER_BRIDGE_VERSION).toBe("0.1.0");
    expect(COMPATIBLE_RECORDER_VERSION).toBe("0.1.0");

    const request: RecorderBridgeRequest = {
      protocol: RECORDER_BRIDGE_PROTOCOL,
      id: "request-1",
      method: "hello",
      params: {},
    };
    expect(request.method).toBe("hello");
  });
});
```

- [ ] **Step 6: Run the focused test and verify RED**

Run:

```bash
yarn test src/protocol.test.ts
```

Expected: FAIL because `protocol.ts` does not exist.

- [ ] **Step 7: Implement the wire declarations**

Define:

```ts
export const RECORDER_BRIDGE_PROTOCOL =
  "jinn.execution-recorder.bridge/v1" as const;
export const RECORDER_BRIDGE_VERSION = "0.1.0" as const;
export const COMPATIBLE_RECORDER_VERSION = "0.1.0" as const;

export type WireArtifactSource =
  | {
      readonly kind: "bytes";
      readonly base64: string;
      readonly mediaType: string;
      readonly name?: string;
    }
  | {
      readonly kind: "path";
      readonly path: string;
      readonly mediaType: string;
      readonly name?: string;
    };
```

Define Recorder-shaped Task, artifact, runtime, trace, start, and finalize
declarations by replacing every Recorder `ArtifactSource` with
`WireArtifactSource`. Do not include `AbortSignal` on the wire. Define requests
for `hello`, `start`, `resume`, `captureInput`,
`captureRuntimeObservation`, `attachNativeTrace`, and `finalize`.

Mutation requests use:

```ts
export interface RecorderBridgeTarget {
  readonly workspaceDir: string;
  readonly executionId: ExecutionId;
}
```

Error responses use:

```ts
export interface RecorderBridgeErrorPayload {
  readonly domain: "bridge" | "recorder" | "repository";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
```

Responses use:

```ts
export type RecorderBridgeResponse =
  | {
      readonly protocol: typeof RECORDER_BRIDGE_PROTOCOL;
      readonly id: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly protocol: typeof RECORDER_BRIDGE_PROTOCOL;
      readonly id: string;
      readonly ok: false;
      readonly error: RecorderBridgeErrorPayload;
    };
```

- [ ] **Step 8: Verify GREEN**

Run:

```bash
yarn typecheck
yarn test src/protocol.test.ts
cd ../../..
node --test .github/scripts/evidence-package-inventory.test.mjs
```

Expected: typecheck exits zero, the focused test reports one pass, and both
inventory tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/evidence/execution-recorder-bridge \
  .github/scripts/evidence-package-inventory.test.mjs
git commit -m "feat(evidence): declare execution recorder bridge"
```

---

### Task 2: Decode exact-byte wire inputs

**Files:**

- Create: `packages/evidence/execution-recorder-bridge/src/errors.ts`
- Create: `packages/evidence/execution-recorder-bridge/src/wire.test.ts`
- Create: `packages/evidence/execution-recorder-bridge/src/wire.ts`
- Modify: `packages/evidence/execution-recorder-bridge/src/index.ts`

**Interfaces:**

- Produces:
  `RecorderBridgeError`,
  `decodeArtifactSource`,
  `decodeStartInput`,
  `decodeInputCapture`,
  `decodeRuntimeObservation`,
  `decodeNativeTrace`, and
  `decodeFinalizeInput`.
- Consumes the method-specific wire types from Task 1.
- Returns the corresponding public Execution Recorder input types.

- [ ] **Step 1: Write failing exact-byte and path tests**

Create `src/wire.test.ts` with these assertions:

```ts
expect(
  decodeArtifactSource({
    kind: "bytes",
    base64: Buffer.from("exact").toString("base64"),
    mediaType: "text/plain",
  }),
).toEqual({
  bytes: new TextEncoder().encode("exact"),
  mediaType: "text/plain",
});

expect(
  decodeArtifactSource({
    kind: "path",
    path: "/tmp/trace.jsonl",
    mediaType: "application/x-ndjson",
  }),
).toEqual({
  path: "/tmp/trace.jsonl",
  mediaType: "application/x-ndjson",
});
```

Use `test.each` to assert that empty media types, empty paths, invalid base64,
unknown source kinds, and ambiguous extra `path`/`base64` fields throw an
`INVALID_REQUEST` `RecorderBridgeError`.

- [ ] **Step 2: Run the decoder test and verify RED**

Run:

```bash
yarn test src/wire.test.ts
```

Expected: FAIL because the decoder exports do not exist.

- [ ] **Step 3: Implement the stable bridge error**

Define:

```ts
export const RECORDER_BRIDGE_ERROR_CODES = [
  "PARSE_ERROR",
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL",
  "METHOD_NOT_FOUND",
  "RECORDING_NOT_ATTACHED",
  "EXECUTION_ID_MISMATCH",
  "INTERNAL_ERROR",
] as const;

export class RecorderBridgeError extends Error {
  override readonly name = "RecorderBridgeError";

  constructor(
    readonly code: (typeof RECORDER_BRIDGE_ERROR_CODES)[number],
    message: string,
  ) {
    super(message);
  }
}
```

- [ ] **Step 4: Implement strict source decoding**

Validate canonical base64:

```ts
const bytes = Buffer.from(value.base64, "base64");
if (bytes.toString("base64") !== value.base64) {
  throw new RecorderBridgeError(
    "INVALID_REQUEST",
    "Artifact bytes must use canonical base64.",
  );
}
```

Implement explicit conversion functions for file artifacts, aggregate
artifacts, Task, repository state, runtime components, runtime observations,
native trace, and Results. Do not recursively rewrite arbitrary JSON-LD
extensions.

- [ ] **Step 5: Add the nested conversion test**

Add a `start` input containing:

- a byte-backed Task;
- a path-backed Runtime Specification;
- controlled and opaque runtime components;
- a nested collection input; and
- repository state.

Assert every artifact source is converted and this extension remains unchanged:

```ts
const extension = {
  nested: {
    kind: "bytes",
    base64: "not-an-artifact-source",
    mediaType: "application/example",
  },
};
expect(decoded.record.executionExtensions).toEqual(extension);
```

- [ ] **Step 6: Run decoder tests and typecheck GREEN**

Run:

```bash
yarn typecheck
yarn test src/wire.test.ts
```

Expected: all decoder tests pass with no warnings.

- [ ] **Step 7: Commit**

```bash
git add packages/evidence/execution-recorder-bridge/src
git commit -m "feat(evidence): decode recorder bridge inputs"
```

---

### Task 3: Dispatch Recorder operations with workspace isolation

**Files:**

- Create: `packages/evidence/execution-recorder-bridge/src/bridge.test.ts`
- Create: `packages/evidence/execution-recorder-bridge/src/bridge.ts`
- Modify: `packages/evidence/execution-recorder-bridge/src/errors.ts`
- Modify: `packages/evidence/execution-recorder-bridge/src/index.ts`

**Interfaces:**

- Produces:

```ts
export interface ExecutionRecorderBridge {
  dispatch(request: unknown): Promise<RecorderBridgeResponse>;
}

export function createExecutionRecorderBridge(options: {
  readonly repository: EvidenceRepository;
}): ExecutionRecorderBridge;
```

- Consumes all Task 2 decoders.
- Uses `ExecutionRecording` handles only in transient memory.

- [ ] **Step 1: Write the failing hello and lifecycle tests**

Using a real filesystem Repository and temporary Recorder workspaces, assert:

1. `hello` returns:

   ```ts
   {
     bridgeVersion: "0.1.0",
     recorderVersion: "0.1.0",
     protocol: "jinn.execution-recorder.bridge/v1",
   }
   ```

2. `start` returns the generated Execution ID and `open` status.
3. `captureInput`, `captureRuntimeObservation`, `attachNativeTrace`, and
   `finalize` drive the attached Recorder recording.
4. A mutation before `start` or `resume` returns
   `RECORDING_NOT_ATTACHED`.
5. A mismatched target Execution ID returns
   `EXECUTION_ID_MISMATCH`.
6. A new bridge instance can `resume` the workspace and recover its state.
7. A path-backed Task is snapshotted during `start`: after `start` succeeds,
   overwrite the source file, finalize, retrieve the stored Task artifact from
   the Repository, and assert that it still contains the pre-overwrite bytes.
8. A symlink or non-regular path source preserves Recorder domain and
   `UNSAFE_PATH` code while omitting the private source path from response
   details.

- [ ] **Step 2: Run the bridge test and verify RED**

Run:

```bash
yarn test src/bridge.test.ts
```

Expected: FAIL because the bridge factory does not exist.

- [ ] **Step 3: Implement request validation and dispatch**

The dispatcher must:

- reject non-object requests;
- reject unsupported protocol versions;
- require a non-empty string request ID;
- reject unknown methods before touching the Recorder;
- decode method payloads with Task 2 functions;
- attach handles only after successful `start` or `resume`;
- key transient handles by the resolved workspace path;
- compare `target.executionId` to the attached handle;
- return `{ executionId, status, receipt? }` after start, resume, and void
  capture calls; and
- return the Recorder's `FinalizeExecutionResult` unchanged.

- [ ] **Step 4: Preserve and sanitize error domains**

Convert failures to:

```ts
{
  domain: "bridge" | "recorder" | "repository",
  code: string,
  message: string,
  details?: Record<string, unknown>,
}
```

Preserve `ExecutionRecorderError.code` and safe scalar fields from its
`details`. Preserve `EvidenceRepositoryError.code`. Never include `cause`,
`stack`, request payloads, artifact bytes, repository credentials, or source
paths in error details.

Unknown errors become:

```ts
{
  domain: "bridge",
  code: "INTERNAL_ERROR",
  message: "Recorder Bridge operation failed.",
}
```

- [ ] **Step 5: Add failing concurrency tests**

Use a controlled test Repository around finalization to prove:

- two finalizations targeting the same workspace never enter a Repository
  write concurrently; and
- finalizations for two different workspaces can enter independently.

The test Repository must delegate exact-byte storage to real filesystem
Repository instances; its only test behavior is a deferred gate around the
first write.

- [ ] **Step 6: Implement per-workspace promise queues**

Use one queue tail per resolved workspace path:

```ts
const previous = queues.get(workspaceDir) ?? Promise.resolve();
const operation = previous.catch(() => undefined).then(run);
const tail = operation.then(
  () => undefined,
  () => undefined,
);
queues.set(workspaceDir, tail);
```

In `finally`, delete the queue only if `queues.get(workspaceDir) === tail`.
Failed operations must release the queue so later retry or resume can proceed.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
yarn typecheck
yarn test src/bridge.test.ts
```

Expected: all bridge tests pass with no output warnings.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence/execution-recorder-bridge/src
git commit -m "feat(evidence): dispatch recorder bridge operations"
```

---

### Task 4: Serve concurrent newline-delimited JSON

**Files:**

- Create: `packages/evidence/execution-recorder-bridge/src/server.test.ts`
- Create: `packages/evidence/execution-recorder-bridge/src/server.ts`
- Modify: `packages/evidence/execution-recorder-bridge/src/index.ts`

**Interfaces:**

- Produces:

```ts
export async function serveExecutionRecorderBridge(options: {
  readonly repository: EvidenceRepository;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}): Promise<void>;
```

- Creates exactly one `ExecutionRecorderBridge` per invocation.

- [ ] **Step 1: Write failing framing tests**

Use `Readable.from()` and a collecting `Writable` to assert:

- one request line produces one response line;
- blank lines are ignored;
- malformed JSON produces a sanitized `PARSE_ERROR` response and the next
  valid line still succeeds;
- request IDs are preserved;
- two independent delayed requests may respond out of input order;
- response writes remain whole, one JSON object per line; and
- end-of-input waits for every accepted request and response write.

- [ ] **Step 2: Run the server test and verify RED**

Run:

```bash
yarn test src/server.test.ts
```

Expected: FAIL because the stream server does not exist.

- [ ] **Step 3: Implement concurrent reads and serialized writes**

Read lines with `node:readline`. Dispatch accepted lines without globally
awaiting each operation. Track pending tasks and wait for them at end-of-input.

Serialize output with one promise tail:

```ts
let outputTail = Promise.resolve();
function enqueueResponse(response: RecorderBridgeResponse): Promise<void> {
  outputTail = outputTail.then(() =>
    writeWithBackpressure(
      options.output,
      `${JSON.stringify(response)}\n`,
    ),
  );
  return outputTail;
}
```

`writeWithBackpressure` resolves immediately when `write()` returns `true`;
otherwise it resolves on `drain` and rejects on `error`.

Malformed JSON uses request ID `""` because no caller ID can be recovered
reliably. It must not terminate the stream.

- [ ] **Step 4: Verify GREEN and regression**

Run:

```bash
yarn typecheck
yarn test src/server.test.ts src/bridge.test.ts src/wire.test.ts
```

Expected: all focused suites pass with no warnings.

- [ ] **Step 5: Commit**

```bash
git add packages/evidence/execution-recorder-bridge/src
git commit -m "feat(evidence): serve recorder bridge over stdio"
```

---

### Task 5: Add the filesystem executable and producer conformance

**Files:**

- Create: `packages/evidence/execution-recorder-bridge/src/cli.test.ts`
- Create: `packages/evidence/execution-recorder-bridge/src/cli.ts`
- Create: `packages/evidence/execution-recorder-bridge/src/bin.ts`
- Create:
  `packages/evidence/execution-recorder-bridge/src/producer-contract.integration.test.ts`
- Modify: `packages/evidence/execution-recorder-bridge/src/index.ts`

**Interfaces:**

- Produces:

```ts
export async function runExecutionRecorderBridgeCli(options: {
  readonly args: readonly string[];
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly error: NodeJS.WritableStream;
}): Promise<number>;
```

- CLI syntax:
  `jinn-execution-recorder-bridge --repository-root <absolute-or-relative-path>`.

- [ ] **Step 1: Write failing CLI tests**

Assert:

- missing `--repository-root` returns exit code `2`;
- duplicate `--repository-root` returns exit code `2`;
- unknown arguments return exit code `2`;
- invalid repository startup returns exit code `1` and one sanitized
  standard-error line;
- valid arguments initialize a real filesystem Repository in a temporary
  directory and serve one `hello` request; and
- protocol responses never appear on standard error.

- [ ] **Step 2: Run CLI tests and verify RED**

Run:

```bash
yarn test src/cli.test.ts
```

Expected: FAIL because the CLI function does not exist.

- [ ] **Step 3: Implement the executable composition**

`bin.ts` begins with:

```ts
#!/usr/bin/env node
```

It calls the CLI with `process.argv.slice(2)`, `process.stdin`,
`process.stdout`, and `process.stderr`, then assigns the returned number to
`process.exitCode`.

The CLI initializes:

```ts
const repository = await createFilesystemEvidenceRepository({
  rootDir: repositoryRoot,
});
await serveExecutionRecorderBridge({
  repository,
  input: options.input,
  output: options.output,
});
```

Argument errors write exactly:

```text
Usage: jinn-execution-recorder-bridge --repository-root <path>
```

Startup failures use a sanitized error code and message but never a stack trace.

- [ ] **Step 4: Write the bridge producer-contract driver**

Use the exported Recorder fixtures and
`describeExecutionProducerContract(...)`. Every driver operation must pass
through:

1. JSON serialization;
2. the stream server;
3. JSON response parsing; and
4. request-ID correlation.

Cover completed, failed, abandoned, and interrupted-finalization recovery.

For interrupted finalization, wrap a real filesystem Repository with a test
Repository that throws the supplied interruption after a successful first
write. Then create a fresh bridge around the unwrapped Repository, call
`resume` on the same workspace, and recover the receipt.

- [ ] **Step 5: Run the producer contract and verify RED**

Run:

```bash
yarn test src/producer-contract.integration.test.ts
```

Expected initial RED: the first scenario fails because the bridge test client
or recovery driver is not yet complete. Record that expected failure before
adding the remaining driver behavior.

- [ ] **Step 6: Complete the minimal test client and driver**

The test client must:

- assign monotonically unique request IDs;
- serialize exactly one request per line;
- correlate out-of-order responses by ID;
- expose only Recorder-shaped helper calls to the driver;
- reject duplicate response IDs;
- fail if standard output contains a non-protocol line; and
- throw bridge errors with their domain and code.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
yarn typecheck
yarn test
yarn build
```

Expected: all package tests pass, build exits zero, and `dist/bin.js` retains
its shebang.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence/execution-recorder-bridge/src
git commit -m "feat(evidence): add recorder bridge executable"
```

---

### Task 6: Verify packed distribution and Evidence architecture

**Files:**

- Create: `packages/evidence/execution-recorder-bridge/README.md`
- Create:
  `packages/evidence/execution-recorder-bridge/scripts/pack-smoke.mjs`
- Modify: `.github/scripts/evidence-source-boundaries.test.mjs`
- Modify: `.github/scripts/evidence-packed-types.test.mjs`
- Modify: `.github/workflows/evidence-ci.yml`

**Interfaces:**

- Packed root export:
  `@jinn-network/execution-recorder-bridge`.
- Packed binary:
  `jinn-execution-recorder-bridge`.
- CI artifact:
  `evidence-execution-recorder-bridge-dist`.

- [ ] **Step 1: Make packed-type and boundary tests expect the bridge**

Add the package and root entrypoint to
`.github/scripts/evidence-packed-types.test.mjs`. Add
`execution-recorder-bridge` to the Evidence directory list in
`.github/scripts/evidence-source-boundaries.test.mjs`.

The boundary test must:

- permit `@jinn-network/evidence-repository/fs` only from
  `execution-recorder-bridge/src/cli.ts`;
- permit `@jinn-network/evidence-protocol` only from bridge test files;
- forbid Protocol imports from bridge production source;
- forbid Repository filesystem imports from bridge core source; and
- forbid imports from Local Evidence Runtime, host, plugin, Autopilot, and
  marketplace paths.

- [ ] **Step 2: Run the architecture gates**

Run from the repository root:

```bash
node --test \
  .github/scripts/evidence-package-inventory.test.mjs \
  .github/scripts/evidence-source-boundaries.test.mjs
```

Expected: both tests pass. If either fails, correct the earlier bridge source or
manifest instead of weakening the boundary. These scripts are executable
architecture gates; the pack-smoke test in the next step supplies this task's
new RED behavior.

- [ ] **Step 3: Write the packed child-process smoke test first**

The smoke script must:

1. pack Protocol, Repository, Recorder, and Bridge into a temporary directory;
2. install those archives in a temporary consumer with
   `npm install --ignore-scripts --no-audit --no-fund`;
3. spawn the installed `jinn-execution-recorder-bridge` binary with a temporary
   filesystem Repository;
4. send `start`, `attachNativeTrace`, and `finalize` requests using byte-backed
   Task, runtime, trace, and Result declarations;
5. close standard input and require exit code zero;
6. retrieve metadata and artifact bytes with the installed Repository package;
   and
7. compare exact trace and Result bytes and their content references.

It must also assert:

- `dist/bin.js` and `dist/index.d.ts` exist in the archive;
- `README.md` exists in the archive;
- source tests are absent;
- the binary's standard output contains only protocol responses; and
- standard error contains neither the Task text nor trace or Result contents.

- [ ] **Step 4: Run pack smoke and verify RED**

Run:

```bash
cd packages/evidence/execution-recorder-bridge
yarn build
yarn pack:smoke
```

Expected: FAIL because the complete smoke script or README distribution is not
yet present.

- [ ] **Step 5: Complete package documentation and smoke behavior**

Document:

- process ownership and one-Repository scope;
- every request and response envelope;
- all Recorder-mirroring method names;
- wire artifact-source shapes;
- request correlation and cross-workspace concurrency;
- explicit `resume` after restart;
- Recorder, Repository, and bridge error domains;
- capture-policy separation;
- filesystem CLI invocation;
- private-data and exact-byte warnings;
- Local Evidence Runtime composition through `runtime.repository`; and
- the explicit no-migration/no-cutover status of the package.

- [ ] **Step 6: Add the bridge CI job**

Add a dedicated job named `execution-recorder-bridge` that needs `foundation`
and `components`. It must:

1. download Protocol, Repository, and Recorder distribution artifacts;
2. install the prerequisite package toolchains;
3. run in `packages/evidence/execution-recorder-bridge`:

   ```bash
   yarn install --immutable
   yarn typecheck
   yarn test
   yarn build
   yarn pack:smoke
   ```

4. upload `packages/evidence/execution-recorder-bridge/dist` as
   `evidence-execution-recorder-bridge-dist`;
5. join the final `verify` job's `needs` list and success gate; and
6. join the packed-distribution placement loop.

- [ ] **Step 7: Run complete verification**

With Node 22 first on `PATH`, run:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

node --test \
  .github/scripts/evidence-package-inventory.test.mjs \
  .github/scripts/evidence-source-boundaries.test.mjs

(
  cd packages/evidence/execution-recorder-bridge
  yarn install --immutable
  yarn typecheck
  yarn test
  yarn build
  yarn pack:smoke
)

for package in \
  repository-oci \
  discovery \
  execution-recorder \
  attestation-issuer \
  catalog-sqlite \
  local-runtime \
  execution-recorder-bridge; do
  (
    cd "packages/evidence/${package}"
    yarn install --immutable
    yarn build
  )
done

node .github/scripts/evidence-packed-types.test.mjs
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 8: Audit the migration and cutover stop line**

Run:

```bash
git diff --name-only \
  f65880c4e244e32334f0fed98bf00ff9b307e87d...HEAD
```

The output may contain only:

- the Capture design and Bridge implementation plan;
- `packages/evidence/execution-recorder-bridge/**`;
- `.github/scripts/evidence-package-inventory.test.mjs`;
- `.github/scripts/evidence-source-boundaries.test.mjs`;
- `.github/scripts/evidence-packed-types.test.mjs`; and
- `.github/workflows/evidence-ci.yml`.

It must contain no `apps/jinn-agent`, `client`, Autopilot, marketplace,
`EpisodeV1`, release, deployment, migration, or cutover path.

- [ ] **Step 9: Commit**

```bash
git add \
  packages/evidence/execution-recorder-bridge \
  .github/scripts/evidence-package-inventory.test.mjs \
  .github/scripts/evidence-source-boundaries.test.mjs \
  .github/scripts/evidence-packed-types.test.mjs \
  .github/workflows/evidence-ci.yml
git commit -m "feat(evidence): distribute execution recorder bridge"
```

## Self-review

- Spec coverage: Tasks 1–6 cover the package boundary, transport, exact-byte
  mapping, lifecycle, state and receipt model, interruption, concurrency,
  errors, privacy-sensitive output, filesystem composition, conformance,
  distribution, and CI.
- Dependency consistency: the bridge has only Recorder and Repository
  production dependencies. Protocol is development-only and exists solely to
  make the stacked portal install resolvable; a source-boundary test prevents a
  production import.
- Migration boundary: no task edits a host, legacy record, consumer, runtime
  configuration, release, deployment, migration, or cutover path.
- Type consistency: `RecorderBridgeTarget`, the seven method names, protocol
  identifier, version constants, error domains, and package names are
  consistent across tasks.
- Placeholder audit: complete; every task names its files, commands, expected
  result, and stopping condition.
