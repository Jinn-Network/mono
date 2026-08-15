// SPDX-License-Identifier: Apache-2.0

import {
  parseEnvironmentRecord,
  sealEnvironmentRecord,
  type EnvironmentRecord,
} from "@jinn-network/environment-record";
import { canonicalJsonBytes, compareCodeUnitStrings, sha256Hex } from "@jinn-network/trust-core";

import { invalidInput } from "./errors.js";
import type { CommandSpec } from "./ports.js";

const DEFAULT_PLATFORM = "linux/amd64";
const DEFAULT_WORKSPACE = "/testbed";
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const DIGEST_QUALIFIED = /@(sha256:[0-9a-f]{64})$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
/** Any shell metacharacter refuses the row. This package never interpolates a
 * shell, and silently tokenizing `a && b` would fabricate a command the
 * upstream row did not declare. */
const SHELL_METACHARACTERS = /[|&;<>$`(){}\[\]*?~!#\n\r"'\\]/u;

/** The upstream dataset row shape this v1 import source reads (SWE-rebench and
 * its relatives). Field names mirror the upstream JSON, hence the snake_case. */
export interface UpstreamEnvironmentRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly repo_url?: string;
  readonly base_commit: string;
  /** MUST be digest-qualified: `registry/name@sha256:<64 hex>`. */
  readonly image_name: string;
  readonly platform?: string;
  readonly workspace?: string;
  readonly install_config: {
    readonly install?: string | readonly string[];
    readonly test_cmd: string | readonly string[];
    readonly log_parser: string;
  };
  readonly parser_version?: string;
  readonly parser_digest?: string;
  readonly parser_uri?: string;
  readonly source_license?: string;
  readonly dataset?: string;
  readonly revision?: string;
  readonly image_provider_id?: string;
  readonly image_provider_version?: string;
}

function toCommandSpecs(
  value: string | readonly string[] | undefined,
  instanceId: string,
  field: string,
): CommandSpec[] {
  if (value === undefined) return [];
  const commands = typeof value === "string" ? [value] : [...value];
  return commands.map((command) => {
    if (SHELL_METACHARACTERS.test(command)) {
      invalidInput(
        `Row ${instanceId}: ${field} "${command}" carries shell metacharacters; `
        + "environment records hold shell-free CommandSpecs only.",
      );
    }
    const tokens = command.trim().split(/\s+/u).filter(Boolean);
    const [bin, ...args] = tokens;
    if (bin === undefined) invalidInput(`Row ${instanceId}: ${field} is empty.`);
    return { bin, args };
  });
}

interface CandidateParts {
  readonly identity: string;
  readonly row: UpstreamEnvironmentRow;
  readonly manifestDigest: string;
  readonly platform: string;
  readonly invocations: { install: CommandSpec[]; test: CommandSpec[] };
  readonly parser: { id: string; version: string; digest: string; uri?: string };
}

function partsFor(row: UpstreamEnvironmentRow): CandidateParts {
  const digestMatch = DIGEST_QUALIFIED.exec(row.image_name);
  if (!digestMatch) {
    invalidInput(
      `Row ${row.instance_id}: image_name "${row.image_name}" is not digest-qualified `
      + "(expected registry/name@sha256:<64 hex>).",
    );
  }
  if (!COMMIT.test(row.base_commit)) {
    invalidInput(`Row ${row.instance_id}: base_commit must be 40 lowercase hex digits.`);
  }
  if (row.source_license === undefined || row.source_license.length === 0) {
    invalidInput(
      `Row ${row.instance_id}: source_license is required (D12 — declared SPDX expression).`,
    );
  }
  if (row.parser_digest === undefined) {
    invalidInput(
      `Row ${row.instance_id}: parser_digest is required — without it, third-party `
      + "re-verification is not executable.",
    );
  }

  const platform = row.platform ?? DEFAULT_PLATFORM;
  const invocations = {
    install: toCommandSpecs(row.install_config.install, row.instance_id, "install"),
    test: toCommandSpecs(row.install_config.test_cmd, row.instance_id, "test_cmd"),
  };
  if (invocations.test.length === 0) {
    invalidInput(`Row ${row.instance_id}: test_cmd is required — it is the verification scope.`);
  }
  const parser = {
    id: row.install_config.log_parser,
    version: row.parser_version ?? "unversioned",
    digest: row.parser_digest,
    ...(row.parser_uri === undefined ? {} : { uri: row.parser_uri }),
  };

  // The FULL record identity (design §6): source repo+commit, image manifest
  // digest, platform, invocations, parser. A narrower key would silently attest
  // a test scope some rows never declared.
  const identity = sha256Hex(canonicalJsonBytes({
    source: { repo: row.repo, commit: row.base_commit },
    image: { manifestDigest: digestMatch[1], platform },
    invocations,
    parser,
  }));

  return { identity, row, manifestDigest: digestMatch[1]!, platform, invocations, parser };
}

function resolveRepoUrl(row: UpstreamEnvironmentRow): string {
  if (row.repo_url !== undefined) return row.repo_url;
  if (!REPO_SLUG.test(row.repo)) {
    invalidInput(`Row ${row.instance_id}: repo_url is required for non-slug repo "${row.repo}".`);
  }
  return `https://github.com/${row.repo}`;
}

function describeProvider(row: UpstreamEnvironmentRow): string {
  return row.image_provider_id === undefined
    ? ""
    : `${row.image_provider_id}@${row.image_provider_version ?? "unversioned"}`;
}

/**
 * Refuses a group whose members disagree on a field the emitted record carries
 * verbatim from one of them. The grouping key is design §6's identity tuple and
 * stays that tuple; these fields sit outside it, so the honest move on
 * divergence is to refuse -- otherwise one row's workspace, license, or origin
 * is signed on behalf of every instance the record attributes.
 */
function refuseDivergence(
  label: string,
  members: readonly CandidateParts[],
  read: (row: UpstreamEnvironmentRow) => string,
): void {
  const values = new Set(members.map((member) => read(member.row)));
  if (values.size > 1) {
    invalidInput(
      `Rows sharing environment identity disagree on ${label}: `
      + `${[...values].sort(compareCodeUnitStrings).join(", ")}.`,
    );
  }
}

/**
 * Groups upstream rows into candidate environment records by full record
 * identity: one record per distinct environment, never one per row. Divergence
 * in any identity component splits the group.
 */
export function buildEnvironmentCandidatesFromRows(
  rows: readonly UpstreamEnvironmentRow[],
): EnvironmentRecord[] {
  const groups = new Map<string, CandidateParts[]>();
  for (const row of rows) {
    const parts = partsFor(row);
    const existing = groups.get(parts.identity);
    if (existing) existing.push(parts);
    else groups.set(parts.identity, [parts]);
  }

  const records: EnvironmentRecord[] = [];
  for (const members of groups.values()) {
    const first = members[0]!;
    const row = first.row;

    refuseDivergence("upstream lineage dataset", members, (member) => member.dataset ?? "");
    refuseDivergence("upstream lineage revision", members, (member) => member.revision ?? "");
    refuseDivergence("workspace", members, (member) => member.workspace ?? DEFAULT_WORKSPACE);
    refuseDivergence("source license", members, (member) => member.source_license!);
    refuseDivergence("source repository URL", members, resolveRepoUrl);
    refuseDivergence("image provider", members, describeProvider);

    const keys = members
      .map((member) => member.row.instance_id)
      .sort(compareCodeUnitStrings);

    const candidate = {
      kind: "https://spec.jinn.network/records/environment/v1",
      source: {
        repo: row.repo,
        repoUrl: resolveRepoUrl(row),
        commit: row.base_commit,
      },
      image: {
        manifestDigest: first.manifestDigest,
        platform: first.platform,
        reference: row.image_name,
      },
      workspace: row.workspace ?? DEFAULT_WORKSPACE,
      invocations: first.invocations.install.length === 0
        ? { test: first.invocations.test }
        : { install: first.invocations.install, test: first.invocations.test },
      parser: first.parser,
      build: {
        reproducibilityTier: 0,
        ...(row.image_provider_id === undefined ? {} : {
          provider: {
            id: row.image_provider_id,
            version: row.image_provider_version ?? "unversioned",
          },
        }),
      },
      rights: { sourceLicense: row.source_license!, basis: "upstream-permissive-filter" },
      ...(row.dataset === undefined ? {} : {
        lineage: {
          upstream: { dataset: row.dataset, revision: row.revision ?? "unversioned", keys },
        },
      }),
    };

    // Round-trip through the record package: sealing validates, parsing returns
    // the canonical parsed shape. A schema divergence surfaces here, loudly.
    records.push(parseEnvironmentRecord(sealEnvironmentRecord(candidate as EnvironmentRecord)));
  }
  return records;
}

/** The row this package's own tests and kit build a record from. */
export const CONFORMANCE_ROW: UpstreamEnvironmentRow = Object.freeze({
  instance_id: "owner__name-1",
  repo: "owner/name",
  repo_url: "https://github.com/owner/name",
  base_commit: "0".repeat(40),
  image_name: `registry.test/owner/name@sha256:${"c".repeat(64)}`,
  platform: "linux/amd64",
  workspace: "/testbed",
  install_config: { test_cmd: "pytest -q tests", log_parser: "pytest" },
  parser_version: "1.0.0",
  parser_digest: `sha256:${"e".repeat(64)}`,
  parser_uri: "https://example.test/parsers/pytest-1.0.0.tar.gz",
  source_license: "MIT",
  dataset: "example/dataset",
  revision: "2026-06-01",
});

export function buildConformanceRecord(): EnvironmentRecord {
  return buildEnvironmentCandidatesFromRows([CONFORMANCE_ROW])[0]!;
}
