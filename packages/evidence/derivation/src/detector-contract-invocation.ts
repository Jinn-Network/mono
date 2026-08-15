// SPDX-License-Identifier: Apache-2.0

import { bytesEqual, canonicalJsonBytes } from "./bytes.js";
import { snapshotDetectors } from "./detectors/index.js";
import { ownDataProperty, snapshotInertData } from "./inert.js";
import type {
  DerivationDetector,
  DerivationFinding,
  DerivationOperationOptions,
  DerivationSurface,
} from "./types.js";

export interface DetectorContractInvocationContext {
  readonly detector: DerivationDetector;
  readonly ambientEffectCount: () => number;
  readonly retainedSurfaceCount: () => number;
}

export function snapshotDetectorContractSlot(
  context: Pick<DetectorContractInvocationContext, "detector">,
): DerivationDetector {
  const detector = ownDataProperty(
    context,
    "detector",
    "detector contract context",
  ) as DerivationDetector;
  return snapshotDetectors([detector])[0]!;
}

export async function invokeContractDetector(
  context: DetectorContractInvocationContext,
  surface: DerivationSurface,
  options?: DerivationOperationOptions,
): Promise<readonly DerivationFinding[]> {
  const surfaceSnapshot = canonicalJsonBytes(
    snapshotInertData(surface, "detector contract surface"),
  );
  const expectReleased = (): void => {
    const ambientEffectCount = context.ambientEffectCount();
    const retainedSurfaceCount = context.retainedSurfaceCount();
    if (ambientEffectCount !== 0) {
      throw new Error(
        `DerivationDetector performed ${ambientEffectCount} ambient effect(s).`,
      );
    }
    if (retainedSurfaceCount !== 0) {
      throw new Error(
        `DerivationDetector retained ${retainedSurfaceCount} surface(s).`,
      );
    }
  };
  expectReleased();
  try {
    return await context.detector.detect(surface, options);
  } finally {
    expectReleased();
    const currentSurface = canonicalJsonBytes(
      snapshotInertData(surface, "detector contract surface"),
    );
    if (!bytesEqual(currentSurface, surfaceSnapshot)) {
      throw new Error("DerivationDetector mutated its input surface.");
    }
  }
}
