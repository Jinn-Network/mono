/**
 * `jinn conformance` verb.
 *
 * Runs the conformance harness against a signed envelope CID and prints the
 * ConformanceReport. Exits 0 on PASS, 1 on FAIL.
 *
 * Usage:
 *   jinn conformance --envelope-cid <cid> [--skip-layer2] [--json]
 */

import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { getConfigPathFromArgs, loadConfig } from '../../config.js';
import { runConformance } from '../../conformance/harness.js';
import type { ConformanceReport } from '../../conformance/types.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        'envelope-cid': { type: 'string' as const },
        'skip-layer2': { type: 'boolean' as const, default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn conformance --envelope-cid bafyxxx',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const envelopeCid = parsed.values['envelope-cid'] as string | undefined;
  if (!envelopeCid) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--envelope-cid is required',
        exampleCli: 'jinn conformance --envelope-cid bafyxxx',
        details: { field: '--envelope-cid', expected: 'non-empty string IPFS CID' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const configPath =
    getConfigPathFromArgs(ctx.argv ?? []) ?? getConfigPathFromArgs(process.argv.slice(2));
  const config = loadConfig(configPath);

  let report: ConformanceReport;
  try {
    report = await runConformance({
      envelopeCid,
      options: {
        ipfsGatewayUrl: config.ipfsGatewayUrl,
        ipfsRegistryUrl: config.ipfsRegistryUrl,
        skipLayer2: parsed.values['skip-layer2'] === true,
      },
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'transient_error',
        message: `Conformance run failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        details: { envelopeCid },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const useJson = Boolean(parsed.values.json);

  if (useJson) {
    ctx.writer.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    ctx.writer.write(`Conformance report for ${report.envelopeCid}\n`);
    ctx.writer.write(`  Tier   : ${report.envelopeTier}\n`);
    ctx.writer.write(
      `  Summary: ${report.summary.passed}/${report.summary.total} passed, ` +
        `${report.summary.failed} failed, ${report.summary.skipped} skipped\n`,
    );
    ctx.writer.write(`  Layer 1: ${report.layer1Passed ? 'PASS' : 'FAIL'}\n`);
    ctx.writer.write(
      `  Layer 2: ${
        report.layer2Passed === 'N/A'
          ? 'N/A (not attested tier)'
          : report.layer2Passed
            ? 'PASS'
            : 'FAIL'
      }\n`,
    );
    ctx.writer.write(`  Overall: ${report.overall}\n`);
    ctx.writer.write('\n');

    for (const c of report.checks) {
      const icon = c.skipped ? '-' : c.passed ? 'ok  ' : 'FAIL';
      const detail = c.detail ? `: ${c.detail}` : '';
      ctx.writer.write(`  [${icon}] [L${c.layer}] ${c.id}${detail}\n`);
    }
  }

  ctx.exit(report.overall === 'PASS' ? 0 : 1);
}

const command: CommandModule = {
  name: 'conformance',
  summary: 'Run the envelope + trajectory conformance suite against a signed envelope CID',
  helpText: `Usage: jinn conformance --envelope-cid <cid> [--skip-layer2] [--json]

Fetches the signed envelope from IPFS and runs the full Layer 1 + Layer 2
conformance suite. Prints a human-readable summary (or JSON with --json).

Layer 1 checks (structural — applies to every envelope):
  envelope.schema          SignedEnvelopeSchema validation
  envelope.payload         KIND_PAYLOADS[kind][role] validation
  envelope.hash-signature  Canonical hash + secp256k1 signature recovery
  trajectory.schema        JinnTrajectoryV1Schema validation
  trajectory.hash-chain    Per-span prevSpanHash chain integrity
  trajectory.span-profile  Required span attributes per SPAN_PROFILE
  artifacts.vocabulary     Required artifactType values present
  artifacts.linkage        Bidirectional span↔artifact linkage
  verdict.back-ref         Verdict restoration-envelope SHA256 back-reference
  verdict.verification-record  Verdict verificationOfRestoration structure
  secret-scrub.compliance  V1 minimum credential scrubbing

Layer 2 checks (attested tier only — source bundle static analysis):
  source.traced-http       All LLM calls via traced HTTP wrapper
  source.mcp-shim          All MCP calls via measured MCP shim
  source.subprocess        No raw child_process outside subprocess wrapper
  source.raw-sockets       No raw TCP/TLS sockets outside socket wrapper
  source.dynamic-code      No eval / new Function / vm.runIn* / dynamic import
  source.artifact-emit     Artifact emission via canonical helper

Flags:
  --envelope-cid <cid>   IPFS CID of the SignedEnvelope to check (required)
  --skip-layer2          Skip Layer 2 (source-static) checks even at attested tier
  --json                 Emit the full ConformanceReport as JSON
  --config <path>        Path to jinn config file

Exit codes:
  0  PASS
  1  FAIL

Examples:
  jinn conformance --envelope-cid bafybeiabc123...
  jinn conformance --envelope-cid bafybeiabc123... --json
  jinn conformance --envelope-cid bafybeiabc123... --skip-layer2
`,
  run,
};

export default command;
