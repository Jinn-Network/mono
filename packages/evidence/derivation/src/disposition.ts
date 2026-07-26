// SPDX-License-Identifier: Apache-2.0

import type {
  ConfidenceBand,
  DerivationDisposition,
  DerivationFinding,
  DerivationHoldReason,
  DerivationPolicy,
  DerivationSurface,
  DispositionCount,
} from "./types.js";

export type SurfaceDispositionResult =
  | {
      readonly status: "retained";
      readonly text: string;
      readonly counts: readonly DispositionCount[];
    }
  | {
      readonly status: "redacted";
      readonly text: string;
      readonly counts: readonly DispositionCount[];
    }
  | {
      readonly status: "withhold-artifact";
      readonly counts: readonly DispositionCount[];
    }
  | {
      readonly status: "review-required";
      readonly findings: readonly DerivationFinding[];
    }
  | {
      readonly status: "withhold-record";
      readonly reasons: readonly DerivationHoldReason[];
    };

const CONFIDENCE: Readonly<Record<ConfidenceBand, number>> = {
  VERY_LOW: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  VERY_HIGH: 4,
};

function dispositionFor(
  finding: DerivationFinding,
  policy: DerivationPolicy,
): DerivationDisposition | undefined {
  let selected: DerivationPolicy["dispositions"][number] | undefined;
  for (const candidate of policy.dispositions) {
    if (
      candidate.class !== finding.class ||
      CONFIDENCE[finding.confidence] <
        CONFIDENCE[candidate.minimumConfidence]
    ) {
      continue;
    }
    if (
      !selected ||
      CONFIDENCE[candidate.minimumConfidence] >
        CONFIDENCE[selected.minimumConfidence]
    ) {
      selected = candidate;
    }
  }
  // Policy parsing rejects duplicate class/floor rows, so the highest floor
  // has exactly one disposition and cannot require an order-dependent tie.
  return selected?.disposition;
}

function counts(
  entries: readonly {
    readonly class: string;
    readonly disposition: Exclude<DerivationDisposition, "retain">;
  }[],
): readonly DispositionCount[] {
  const grouped = new Map<string, DispositionCount>();
  for (const entry of entries) {
    const key = `${entry.class}\u0000${entry.disposition}`;
    const current = grouped.get(key);
    grouped.set(key, {
      ...entry,
      count: (current?.count ?? 0) + 1,
    });
  }
  return Object.freeze(
    [...grouped.values()].sort(
      (left, right) =>
        left.class.localeCompare(right.class) ||
        left.disposition.localeCompare(right.disposition),
    ),
  );
}

export function applyDerivationDispositions(
  surface: DerivationSurface,
  findings: readonly DerivationFinding[],
  policy: DerivationPolicy,
): SurfaceDispositionResult {
  const decided = findings.map((finding) => ({
    finding,
    disposition: dispositionFor(finding, policy),
  }));
  const unmatched = decided
    .filter(({ disposition }) => disposition === undefined)
    .map(({ finding }) => finding);
  if (
    decided.some(({ disposition }) => disposition === "withhold-record") ||
    (unmatched.length > 0 &&
      policy.unmatchedFindingDisposition === "withhold-record")
  ) {
    return {
      status: "withhold-record",
      reasons: [
        {
          code:
            unmatched.length > 0
              ? "finding-disposition-unavailable"
              : "finding-withheld-record",
        },
      ],
    };
  }
  const review = decided
    .filter(({ disposition }) => disposition === "review")
    .map(({ finding }) => finding)
    .concat(
      policy.unmatchedFindingDisposition === "review" ? unmatched : [],
    );
  if (review.length > 0) {
    return { status: "review-required", findings: Object.freeze(review) };
  }
  const effective = decided.filter(
    ({ disposition }) => disposition !== "retain",
  );
  const dispositionCounts = counts(
    effective.map(({ finding, disposition }) => ({
      class: finding.class,
      disposition: disposition as Exclude<DerivationDisposition, "retain">,
    })),
  );
  if (
    effective.some(
      ({ disposition }) => disposition === "withhold-artifact",
    )
  ) {
    return { status: "withhold-artifact", counts: dispositionCounts };
  }
  const redactions = effective
    .filter(({ disposition }) => disposition === "redact")
    .sort(
      (left, right) =>
        CONFIDENCE[right.finding.confidence] -
          CONFIDENCE[left.finding.confidence] ||
        left.finding.class.localeCompare(right.finding.class) ||
        left.finding.detector.id.localeCompare(right.finding.detector.id),
    );
  const selected: typeof redactions = [];
  for (const candidate of redactions) {
    if (
      selected.every(
        ({ finding }) =>
          candidate.finding.end <= finding.start ||
          candidate.finding.start >= finding.end,
      )
    ) {
      selected.push(candidate);
    }
  }
  if (selected.length === 0) {
    return { status: "retained", text: surface.text, counts: [] };
  }
  let text = surface.text;
  for (const { finding } of selected.sort(
    (left, right) => right.finding.start - left.finding.start,
  )) {
    text =
      text.slice(0, finding.start) +
      policy.stubs[finding.class] +
      text.slice(finding.end);
  }
  return { status: "redacted", text, counts: dispositionCounts };
}
