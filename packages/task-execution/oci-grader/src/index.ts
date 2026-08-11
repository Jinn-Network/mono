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
