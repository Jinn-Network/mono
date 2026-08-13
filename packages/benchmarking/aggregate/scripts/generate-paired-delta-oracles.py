#!/usr/bin/env python3
"""Generate Demo-1's independent paired-delta BCa assurance oracle.

This program is intentionally independent of the TypeScript estimator. It uses CPython's
documented ``statistics.NormalDist`` implementation for the normal CDF/inverse CDF, independently
replays the frozen xorshift32-v1 stream, and uses the inverse empirical CDF (Hyndman-Fan type 1)
for endpoint selection. The product's floor-index rule may differ by one adjacent order statistic;
the conformance test applies the pre-declared H4 tolerance.

Required generation runtime: CPython 3.11.0, standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import pathlib
import platform
import statistics
import sys
from typing import Any, Iterable


RUNTIME = "CPython 3.11.0"
NORMAL_REFERENCE = "Python statistics.NormalDist (Python 3.11.0 standard library)"
SCHEMA = "jinn.demo1.paired-delta-bca-oracle.v1"


def rate(task: str, cluster: str, delta: float) -> dict[str, Any]:
    if not -1 <= delta <= 1:
        raise ValueError("paired rate difference must be in [-1, 1]")
    return {
        "taskDigest": task,
        "cluster": ["source", cluster],
        "pA": max(0.0, -delta),
        "pB": max(0.0, delta),
    }


CASES = [
    {
        "id": "balanced-six-singletons",
        "description": "Six equal-size repository clusters with mixed paired rate differences.",
        "seed": 123_456_789,
        "resamples": 20_000,
        "alpha": 0.05,
        "rates": [
            rate("t1", "repo-a", 1.0),
            rate("t2", "repo-b", 0.5),
            rate("t3", "repo-c", 0.0),
            rate("t4", "repo-d", -0.5),
            rate("t5", "repo-e", -0.5),
            rate("t6", "repo-f", 0.5),
        ],
    },
    {
        "id": "unequal-correlated-clusters",
        "description": "Four repositories of sizes 1, 2, 3, and 4 with strongly correlated within-repository deltas.",
        "seed": 2_654_435_761,
        "resamples": 20_000,
        "alpha": 0.05,
        "rates": [
            rate("u01", "repo-a", -0.10),
            rate("u02", "repo-b", 0.08),
            rate("u03", "repo-b", 0.12),
            rate("u04", "repo-c", -0.06),
            rate("u05", "repo-c", -0.04),
            rate("u06", "repo-c", -0.05),
            rate("u07", "repo-d", 0.04),
            rate("u08", "repo-d", 0.06),
            rate("u09", "repo-d", 0.05),
            rate("u10", "repo-d", 0.05),
        ],
    },
    {
        "id": "discrete-tie-mass",
        "description": "Six singleton repositories with symmetric binary-fraction deltas and non-trivial bootstrap ties.",
        "seed": 3_735_928_559,
        "resamples": 20_000,
        "alpha": 0.05,
        "rates": [
            rate("d1", "repo-a", -0.25),
            rate("d2", "repo-b", -0.125),
            rate("d3", "repo-c", 0.0),
            rate("d4", "repo-d", 0.0),
            rate("d5", "repo-e", 0.125),
            rate("d6", "repo-f", 0.25),
        ],
    },
]


def mean(values: Iterable[float]) -> float:
    values = list(values)
    return sum(values) / len(values)


def ordered_clusters(rates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in sorted(rates, key=lambda entry: entry["taskDigest"]):
        groups.setdefault(tuple(item["cluster"]), []).append(item)
    return [
        {"key": list(key), "members": groups[key]}
        for key in sorted(groups)
    ]


def xorshift32(seed: int):
    state = seed & 0xFFFF_FFFF
    while True:
        state = (state ^ ((state << 13) & 0xFFFF_FFFF)) & 0xFFFF_FFFF
        state = (state ^ (state >> 17)) & 0xFFFF_FFFF
        state = (state ^ ((state << 5) & 0xFFFF_FFFF)) & 0xFFFF_FFFF
        yield state


def cluster_bootstrap(rates: list[dict[str, Any]], seed: int, resamples: int):
    clusters = ordered_clusters(rates)
    stream = xorshift32(seed)
    estimates: list[float] = []
    for _replicate in range(resamples):
        sample: list[dict[str, Any]] = []
        for _position in clusters:
            index = math.floor((next(stream) / 4_294_967_296) * len(clusters))
            sample.extend(clusters[index]["members"])
        estimates.append(mean(item["pB"] - item["pA"] for item in sample))
    estimates.sort()
    return clusters, estimates


def acceleration(clusters: list[dict[str, Any]]) -> float:
    jackknife = []
    for omitted in range(len(clusters)):
        members = [
            member
            for index, cluster in enumerate(clusters)
            if index != omitted
            for member in cluster["members"]
        ]
        jackknife.append(mean(member["pB"] - member["pA"] for member in members))
    center = mean(jackknife)
    numerator = sum((center - estimate) ** 3 for estimate in jackknife)
    sum_squares = sum((center - estimate) ** 2 for estimate in jackknife)
    return 0.0 if sum_squares == 0 else numerator / (6 * sum_squares ** 1.5)


def endpoint(
    sorted_estimates: list[float],
    observed: float,
    acceleration_value: float,
    alpha: float,
    convention: str,
) -> dict[str, Any]:
    below = sum(value < observed for value in sorted_estimates)
    ties = sum(value == observed for value in sorted_estimates)
    numerator = below if convention == "strict-less-than" else below + ties / 2
    proportion = min(max(numerator / len(sorted_estimates), 1e-6), 1 - 1e-6)
    normal = statistics.NormalDist()
    bias = normal.inv_cdf(proportion)
    combined = bias + normal.inv_cdf(alpha)
    denominator = 1 - acceleration_value * combined
    adjusted_z = (-math.inf if combined < 0 else math.inf) if denominator == 0 else bias + combined / denominator
    adjusted_quantile = normal.cdf(adjusted_z)
    # Inverse empirical CDF / Hyndman-Fan type 1: one-based ceil(n*p), clamped at the edges.
    index = min(len(sorted_estimates) - 1, max(0, math.ceil(adjusted_quantile * len(sorted_estimates)) - 1))
    return {
        "adjustedIndex": index,
        "adjustedQuantile": adjusted_quantile,
        "biasCorrection": bias,
        "value": sorted_estimates[index],
        "below": below,
        "ties": ties,
        "tieMass": ties / len(sorted_estimates),
    }


def anova_icc(clusters: list[dict[str, Any]]) -> float:
    values = [[member["pB"] - member["pA"] for member in cluster["members"]] for cluster in clusters]
    count = sum(len(group) for group in values)
    grand = mean(value for group in values for value in group)
    group_means = [mean(group) for group in values]
    between = sum(len(group) * (group_mean - grand) ** 2 for group, group_mean in zip(values, group_means))
    within = sum((value - group_mean) ** 2 for group, group_mean in zip(values, group_means) for value in group)
    mean_between = between / (len(values) - 1)
    mean_within = within / (count - len(values))
    effective_size = (count - sum(len(group) ** 2 for group in values) / count) / (len(values) - 1)
    return (mean_between - mean_within) / (mean_between + (effective_size - 1) * mean_within)


def exact_cluster_bootstrap_audit(clusters: list[dict[str, Any]], observed: float, interval: dict[str, Any]):
    estimates = []
    for selected in itertools.product(range(len(clusters)), repeat=len(clusters)):
        members = [member for index in selected for member in clusters[index]["members"]]
        estimates.append(mean(member["pB"] - member["pA"] for member in members))
    expected = mean(estimates)
    half_width = (interval["strict"]["high"]["value"] - interval["strict"]["low"]["value"]) / 2
    offset = expected - observed
    return {
        "enumeratedSelections": len(estimates),
        "expectedBootstrapMean": expected,
        "intraclassCorrelationAnova": anova_icc(clusters),
        "offset": offset,
        "absoluteOffset": abs(offset),
        "strictIntervalHalfWidth": half_width,
        "offsetShareOfHalfWidth": abs(offset) / half_width,
    }


def build_case(case: dict[str, Any]) -> dict[str, Any]:
    rates = case["rates"]
    clusters, estimates = cluster_bootstrap(rates, case["seed"], case["resamples"])
    observed = mean(item["pB"] - item["pA"] for item in sorted(rates, key=lambda item: item["taskDigest"]))
    acceleration_value = acceleration(clusters)
    interval: dict[str, Any] = {}
    for convention in ("strict-less-than", "mid-p"):
        interval["strict" if convention == "strict-less-than" else "midP"] = {
            "low": endpoint(estimates, observed, acceleration_value, case["alpha"] / 2, convention),
            "high": endpoint(estimates, observed, acceleration_value, 1 - case["alpha"] / 2, convention),
        }
    output = {
        **case,
        "oracle": {
            "observed": observed,
            "acceleration": acceleration_value,
            "draws": case["resamples"] * len(clusters),
            "clusterManifest": [
                {"key": cluster["key"], "members": [member["taskDigest"] for member in cluster["members"]]}
                for cluster in clusters
            ],
            "sortedResampleVectorSha256": hashlib.sha256(
                "\n".join(value.hex() for value in estimates).encode("ascii")
            ).hexdigest(),
            **interval,
        },
    }
    if case["id"] == "unequal-correlated-clusters":
        output["taskAverageAudit"] = exact_cluster_bootstrap_audit(clusters, observed, interval)
    return output


def document() -> dict[str, Any]:
    script = pathlib.Path(__file__).read_bytes()
    return {
        "schema": SCHEMA,
        "reference": {
            "runtime": RUNTIME,
            "normalDistribution": NORMAL_REFERENCE,
            "generator": "scripts/generate-paired-delta-oracles.py",
            "generatorSha256": hashlib.sha256(script).hexdigest(),
            "quantileConvention": "inverse-empirical-cdf-hyndman-fan-type-1",
            "bootstrap": "whole-source-cluster-with-replacement over the frozen xorshift32-v1 stream",
            "tieConventions": ["strict-less-than", "mid-p"],
        },
        "decisionAudit": {
            "pairedDeltaV1Convention": "strict-less-than",
            "sensitivityConvention": "mid-p",
            "publicSemanticsChanged": False,
            "postRunRequirement": "Publish tie mass and strict-versus-mid-p endpoint/verdict sensitivity for the locked slate.",
        },
        "fixtures": [build_case(case) for case in CASES],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", type=pathlib.Path)
    args = parser.parse_args()
    observed_runtime = f"{platform.python_implementation()} {platform.python_version()}"
    if observed_runtime != RUNTIME:
        raise SystemExit(f"oracle generation requires {RUNTIME}; observed {observed_runtime}")
    rendered = json.dumps(
        document(), sort_keys=True, ensure_ascii=False, separators=(",", ":")
    ) + "\n"
    if args.check is None:
        sys.stdout.write(rendered)
        return 0
    current = args.check.read_text(encoding="utf-8")
    if current != rendered:
        raise SystemExit(f"oracle fixture is stale: {args.check}")
    print(f"oracle fixture exact: {args.check}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
