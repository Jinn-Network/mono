// SPDX-License-Identifier: Apache-2.0

/** This package's version, kept in step with package.json by `index.test.ts`. */
export const PACKAGE_VERSION = "0.1.0";

export {
  buildPinnedOciInvocation,
  PINNED_IMAGE,
  type PinnedOciGraderInput,
  type PinnedOciInvocation,
} from "./invocation.js";

export {
  ensurePinnedOciImage,
  runPinnedOciGrader,
  type GraderChildProcess,
  type GraderProcessSpawner,
  type PinnedOciRunnerOptions,
} from "./runner.js";

export { canonicalJsonBytes, sha256Hex } from "./canonical.js";
export {
  graderProgramDigest,
  SWE_REBENCH_OCI_GRADER_PROGRAM,
  SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES,
} from "./grader-program.js";

export {
  exactSweRebenchTestCommands,
  pinnedSweRebenchImage,
  SWE_REBENCH_PUBLIC_NETWORK_EXTENSION,
  sweRebenchOciGraderReportSource,
  type SweRebenchOciGraderSourceOptions,
} from "./swe-rebench-source.js";
