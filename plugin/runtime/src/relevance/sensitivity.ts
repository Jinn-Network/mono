// SPDX-License-Identifier: Apache-2.0
import {
  createBuiltinDerivationDetectors,
  type ConfidenceBand,
  type DerivationDetector,
  type DerivationRole,
  type DerivationSurface,
} from "@jinn-network/evidence-derivation";

import { compareCodeUnitStrings } from "./order.js";
import { readOrCreateSensitivityNonce, type SensitivityNonceIO } from "./nonce.js";

/**
 * The classes whose presence keeps material out of retrieval projections. Spec §6.4 names
 * the target precisely — "credentials, key-shaped material, funds-controlling secrets" —
 * and this is that set, no wider.
 *
 * The identity and PII classes the same detectors emit (`email`, `absolute-path`,
 * `wallet-address`, `git-identity`, `machine-identity`, `ip-address`, `known-identity`)
 * are deliberately absent: the threat here is re-injection of a *secret*, nothing leaves
 * the machine in this scope, and excluding `absolute-path` alone would empty the local
 * plane's index. Those classes are handled at the publication boundary by
 * `evidence/derivation` proper when the outbound lane un-parks.
 */
export const SENSITIVE_CLASSES: ReadonlySet<string> = new Set([
  "credential",
  "funds-controlling-secret",
  "high-entropy-secret",
  "url-credential",
  "payment-instrument",
  "environment-dump",
]);

/** Every sensitive class above is emitted at VERY_HIGH except `high-entropy-secret` (HIGH). */
export const EXCLUDING_BANDS: ReadonlySet<ConfidenceBand> = new Set<ConfidenceBand>([
  "HIGH",
  "VERY_HIGH",
]);

/** The pseudo-class recorded when a detector itself fails; exclusion is fail-closed. */
export const DETECTOR_FAILURE_CLASS = "detector-failure" as const;

export interface ClassifyInput {
  readonly text: string;
  readonly sourceEntityId: string;
  readonly role: DerivationRole;
}

export type SensitivityVerdict =
  | { readonly excluded: false }
  | { readonly excluded: true; readonly classes: readonly string[] };

export interface SensitivityClassifier {
  classify(input: ClassifyInput): Promise<SensitivityVerdict>;
}

export interface SensitivityClassifierOptions {
  readonly noncePath: string;
  readonly knownIdentities: readonly string[];
  /** Injected from the composition root (C5-P3); library code does not import `node:fs*`. */
  readonly nonceIo: SensitivityNonceIO;
  /** Test seam only; production always uses the built-in detectors. */
  readonly detectors?: readonly DerivationDetector[];
}

let surfaceCounter = 0;

function toSurface(input: ClassifyInput): DerivationSurface {
  surfaceCounter += 1;
  return {
    surfaceId: `artifact:${input.sourceEntityId}:excerpt-${surfaceCounter}`,
    sourceEntityId: input.sourceEntityId,
    role: input.role,
    mediaType: "text/plain",
    codec: "text",
    location: "",
    text: input.text,
  };
}

export async function createSensitivityClassifier(
  options: SensitivityClassifierOptions,
): Promise<SensitivityClassifier> {
  const detectors =
    options.detectors ??
    createBuiltinDerivationDetectors({
      privateConfiguration: {
        schemaVersion: "jinn.private-detector-configuration.v1",
        nonce: await readOrCreateSensitivityNonce(options.noncePath, options.nonceIo),
        knownIdentities: [...options.knownIdentities],
        privateAllowlist: [],
      },
    });

  return {
    async classify(input: ClassifyInput): Promise<SensitivityVerdict> {
      if (input.text.length === 0) return { excluded: false };
      const surface = toSurface(input);
      const classes = new Set<string>();
      for (const detector of detectors) {
        let findings;
        try {
          findings = await detector.detect(surface);
        } catch {
          // Fail closed: material we could not classify is material we do not project.
          classes.add(DETECTOR_FAILURE_CLASS);
          continue;
        }
        for (const finding of findings) {
          if (!SENSITIVE_CLASSES.has(finding.class)) continue;
          if (!EXCLUDING_BANDS.has(finding.confidence)) continue;
          classes.add(finding.class);
        }
      }
      if (classes.size === 0) return { excluded: false };
      return {
        excluded: true,
        classes: [...classes].sort(compareCodeUnitStrings),
      };
    },
  };
}
