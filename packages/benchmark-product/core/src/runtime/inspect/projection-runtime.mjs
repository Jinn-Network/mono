import { evaluateVerdictRule } from "@jinn-network/task-execution-profiles";

const SCORE_SHAPE_ORDER = ["null", "boolean", "number", "string", "list", "object"];

function equalJson(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return equalJson(leftKeys, rightKeys)
      && leftKeys.every((key) => equalJson(left[key], right[key]));
  }
  return Object.is(left, right);
}

function equalStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isMultiScorerSelection(manifest) {
  return manifest?.scoring !== undefined && Array.isArray(manifest?.scorers);
}

/** The single product-private implementation of the locked multi-scorer projection. */
export function projectInspectCellVerdictRuntime(summary, manifest) {
  if (!isMultiScorerSelection(manifest)) {
    throw new TypeError("Inspect summary v2 requires a multi-scorer selection manifest");
  }
  const scorerNames = summary.scorers.map((scorer) => scorer.name);
  if (!equalStrings(scorerNames, manifest.scorers.map((scorer) => scorer.name))) {
    throw new TypeError("Inspect scorer inventory differs from the sealed ordered scorer set");
  }
  for (const scorer of summary.scorers) {
    if (scorer.presentSamples + scorer.missingSamples !== summary.observedSamples) {
      throw new TypeError("Inspect scorer inventory does not account for every observed sample");
    }
    const canonicalShapes = SCORE_SHAPE_ORDER.filter((shape) => scorer.valueShapes.includes(shape));
    if (!equalStrings(scorer.valueShapes, canonicalShapes)) {
      throw new TypeError("Inspect scorer value shapes are duplicated or non-canonical");
    }
  }
  if (summary.measurements.length !== manifest.scoring.projections.length) {
    throw new TypeError("Inspect summary measurement count differs from the sealed projections");
  }
  const values = {};
  summary.measurements.forEach((measurement, index) => {
    const projection = manifest.scoring.projections[index];
    if (
      projection === undefined
      || measurement.measurementName !== projection.measurementName
      || measurement.scorerName !== projection.scorerName
      || measurement.subScoreKey !== projection.subScoreKey
      || measurement.missingSamples + measurement.invalidValueSamples > summary.observedSamples
    ) {
      throw new TypeError("Inspect summary measurement differs from its sealed projection");
    }
    if (summary.terminal === "scored") {
      if (
        measurement.value === null
        || measurement.missingSamples !== 0
        || measurement.invalidValueSamples !== 0
      ) {
        throw new TypeError("scored Inspect summary carries an incomplete projected measurement");
      }
      values[measurement.measurementName] = measurement.value;
    } else if (measurement.value !== null) {
      throw new TypeError("unscorable Inspect summary carries a projected measurement value");
    }
  });
  if (summary.terminal === "unscorable") return null;
  if (
    summary.inspectStatus !== "success"
    || summary.invalidated
    || summary.erroredSamples !== 0
    || summary.expectedSamples === null
    || summary.expectedSamples !== summary.observedSamples
  ) {
    throw new TypeError("scored Inspect summary contradicts its run/sample accounting");
  }
  return evaluateVerdictRule(manifest.scoring.verdictRule, values).verdict;
}

function comparableSummary(summary) {
  const common = {
    terminal: summary.terminal,
    inspectStatus: summary.inspectStatus,
    expectedSamples: summary.expectedSamples,
    observedSamples: summary.observedSamples,
    erroredSamples: summary.erroredSamples,
    invalidated: summary.invalidated,
    nativeLogSha256: summary.nativeLogSha256,
    nativeLogBytes: summary.nativeLogBytes,
  };
  return summary.schema.endsWith("/1")
    ? {
      summarySchema: summary.schema,
      ...common,
      missingScoreSamples: summary.missingScoreSamples,
      scorer: summary.scorer,
      measurement: summary.measurement,
    }
    : {
      summarySchema: summary.schema,
      ...common,
      scorers: summary.scorers,
      measurements: summary.measurements,
    };
}

/** Cross-check facts independently read from the EvalLog and recompute the sealed Jinn rule. */
export function verifyInspectLogProjectionRuntime(summary, observation, manifest) {
  if (summary.schema !== observation.summarySchema) {
    throw new TypeError("Inspect log observation and execution summary use different schemas");
  }
  const observedComparable = { ...observation };
  delete observedComparable.schema;
  if (!equalJson(comparableSummary(summary), observedComparable)) {
    throw new TypeError("Inspect execution summary differs from the independently read native log");
  }
  if (observation.summarySchema.endsWith("/1")) {
    if (isMultiScorerSelection(manifest)) {
      throw new TypeError("legacy Inspect observation cannot verify a multi-scorer selection");
    }
    if (observation.terminal === "scored" && typeof observation.measurement !== "boolean") {
      throw new TypeError("scored Inspect log observation carries no measurement");
    }
    const verdict = observation.terminal === "unscorable"
      ? null
      : evaluateVerdictRule(
        { threshold: { measurement: "inspect-score-pass", op: "eq", value: true } },
        { "inspect-score-pass": observation.measurement },
      ).verdict;
    if (summary.verdict !== verdict) {
      throw new TypeError("Inspect execution summary verdict differs from the sealed projection");
    }
    return {
      verdict,
      measurements: observation.measurement === null
        ? []
        : [{ name: "inspect-score-pass", value: observation.measurement }],
    };
  }
  const projectedSummary = {
    schema: "jinn.network/benchmark-product/inspect-cell-summary/2",
    terminal: observation.terminal,
    inspectStatus: observation.inspectStatus,
    expectedSamples: observation.expectedSamples,
    observedSamples: observation.observedSamples,
    erroredSamples: observation.erroredSamples,
    invalidated: observation.invalidated,
    scorers: observation.scorers,
    measurements: observation.measurements,
    verdict: summary.verdict,
    evaluatedAt: summary.evaluatedAt,
    nativeLogSha256: observation.nativeLogSha256,
    nativeLogBytes: observation.nativeLogBytes,
  };
  const verdict = projectInspectCellVerdictRuntime(projectedSummary, manifest);
  if (summary.verdict !== verdict) {
    throw new TypeError("Inspect execution summary verdict differs from the sealed projection");
  }
  return {
    verdict,
    measurements: observation.measurements.flatMap((measurement) => measurement.value === null
      ? []
      : [{ name: measurement.measurementName, value: measurement.value }]),
  };
}
