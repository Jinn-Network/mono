// SPDX-License-Identifier: MIT

import { prefixedDigest } from "@jinn-network/policy-identity";
import {
  graderProgramDigest,
  sweRebenchOciGraderReportSource,
  type SweRebenchOciGraderSourceOptions,
} from "@jinn-network/task-execution-oci-grader";

export {
  exactSweRebenchTestCommands,
  pinnedSweRebenchImage,
  SWE_REBENCH_OCI_GRADER_PROGRAM,
  SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES,
  SWE_REBENCH_PUBLIC_NETWORK_EXTENSION,
} from "@jinn-network/task-execution-oci-grader";

export const LOCAL_SWE_REBENCH_EVALUATION_METHOD_TOKEN =
  "network.jinn.policy-optimization.swe-rebench-oci-evaluator/1.2" as const;

/** Product method identity binds the current neutral grader program without copying its bytes. */
export const LOCAL_SWE_REBENCH_EVALUATION_METHOD = Object.freeze({
  name: "Jinn local SWE-rebench OCI evaluator",
  uri: `urn:jinn:method:${LOCAL_SWE_REBENCH_EVALUATION_METHOD_TOKEN}`,
  digest: {
    sha256: prefixedDigest(new TextEncoder().encode(
      `${LOCAL_SWE_REBENCH_EVALUATION_METHOD_TOKEN}\0${graderProgramDigest()}`,
    )).slice("sha256:".length),
  },
});

export interface LiveSweRebenchGraderSourceOptions {
  readonly runtime?: "docker" | "podman";
  readonly attemptWorkRoot?: () => string;
}

/** Private product composition over the current shared OCI grader. */
export function liveSweRebenchGraderReportSource(
  options: LiveSweRebenchGraderSourceOptions = {},
) {
  const sharedOptions: SweRebenchOciGraderSourceOptions = {
    ...options,
    // Parent preparation pre-stages exact images; evaluator children gain no registry authority.
    runner: { imagePullPolicy: "never" },
    // The shared source still requires the sealed profile extension before creating a network.
    allowPublicNetwork: true,
  };
  return sweRebenchOciGraderReportSource(sharedOptions);
}
