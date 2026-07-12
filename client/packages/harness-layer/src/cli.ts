/**
 * jinn-layer CLI — the human surface over the harness-layer consume path.
 *
 * Verbs (same command-module spirit as client/src/cli/commands/, kept
 * self-contained so the package stays embeddable):
 *
 *   jinn-layer corpus search "<query>" [--limit N] [--json]
 *   jinn-layer corpus get <ref> [--json] [--out <dir>]
 *   jinn-layer capture preview <task-file> [--json]
 *
 * Output is human-readable by default (this is a discovery surface);
 * --json emits the typed result as JSON (artifact content base64-encoded).
 * `capture preview` renders the scrub report: the redaction diff (original
 * values shown on the terminal only — they never leave the machine) and the
 * envelope exactly as it would publish. Its --json output strips the
 * original values so it stays persistence-safe.
 */

import { parseArgs } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createHarnessLayer,
  DEFAULT_IPFS_GATEWAY_URL,
  type CorpusRecord,
  type CorpusSearchHit,
  type HarnessLayer,
} from './consume.js';
import { capture, parseCapturedTask, type CapturedTask, type ScrubRedaction } from './capture.js';
import { preview, stripBeforeValues, type ScrubReport } from './preview.js';
import { createMemoryLedger, DEFAULT_LEDGER_PATH, ledger, type LedgerEntry } from './ledger.js';
import { publish, type HarnessPublishDeps } from './publish.js';
import { createLivePublishDeps } from './publish-live.js';
import {
  createGithubSeedSource,
  parseSeedListEntry,
  type SeedSource,
} from './seed-import/fetch.js';
import { plan as seedPlan } from './seed-import/plan.js';
import { execute as seedExecute } from './seed-import/execute.js';
import { parseImportReport, renderImportReport } from './seed-import/report.js';
import { extractSkill } from './skill.js';
import { isInsidePackageDir } from '../../../src/util/path-safety.js';
import { runDistillationPipeline } from './pipeline.js';
import { createVerdictSource, type VerdictSource } from './bridge-verdict-source.js';
import { createEvidenceFetcher } from './bridge-fetch-evidence.js';
import {
  createClaudeDistiller,
  createClaudeMetaDistiller,
  createCodexDistiller,
  createCodexMetaDistiller,
  DEFAULT_CODEX_MODEL,
  DEFAULT_MODEL as DEFAULT_CLAUDE_DISTILL_MODEL,
} from './distill-llm.js';
import { createLocalDistiller, createLocalSkillSink } from './distiller.js';
import {
  DEFAULT_DISTIL_MODE_PATH,
  readDistilMode,
  writeDistilMode,
  type DistilMode,
} from './distil-mode.js';
import {
  DEFAULT_CAPTURES_DIR,
  DEFAULT_DISTIL_CAPTURE_LIMIT,
  DEFAULT_SKILLS_INSTALL_DIR,
  coveredSessionIds,
  loadRecentCaptures,
  provenanceLabels,
  stagingDirFor,
} from './distil-captures.js';
import {
  renderConsentDisclosure,
  renderPreview,
  renderConfirmLocal,
  renderModeSet,
  renderDeferredRun,
  renderRecorded,
  renderEmpty,
  renderRunSummary,
  renderReview,
  renderFailure,
  renderResumeNothing,
  type RenderedSkill,
} from './distil-render.js';
import type { AttemptRef, BridgeEvidence } from './bridge.js';
import type { DistillCluster, DistillLLMOutput, MetaDistillLLMOutput } from './distill.js';
import type { MetaCluster } from './cluster.js';
import { DEFAULT_TESTNET_DISCOVERY_URL } from '../../../src/config.js';
import {
  loadActiveHeldOutSlateIds,
  ACTIVE_HELD_OUT_SLATE_VERSIONS,
} from '../../../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import { decryptMnemonic, walletPrivateKeyAtIndex } from '../../../src/earning/wallet.js';
import {
  FleetStateStore,
  DEFAULT_EARNING_DIR,
  mnemonicKeystorePath,
} from '../../../src/earning/store.js';
import { isOperationalServiceStep } from '../../../src/earning/types.js';
import { resolveCliPassword } from '../../../src/cli/password.js';

const USAGE = `Usage: jinn-layer <command> [args]

Commands:
  corpus search "<query>" [--limit N] [--json]   Search corpus records (substring match on
                                                 solverType / role / artifactType / refs)
  corpus get <ref> [--json] [--out <dir>]        Fetch a record by ref (manifest CID from a
                                                 search result), including artifact content
  skills install <ref> [--out <dir>] [--json]    Install the skill carried by a corpus record
                                                 (jinn.skill.v1 artifact, or the legacy seeded
                                                 trace shape): writes SKILL.md + companion files
                                                 to <dir> (default ./<skill-name slug>)
  capture preview <task-file> [--json]           Scrub a captured task and show exactly what
                                                 would leave this machine: the redaction diff
                                                 plus the envelope as it would publish
  ledger [--path <file>] [--json]                The contribution ledger: what left this
                                                 machine, with anchor tx explorer links
  publish <task-file> [--veto] [--json]          Scrub, consent, publish and anchor a captured
                                                 task on testnet (--veto records locally and
                                                 publishes nothing)
  derive-env                                     Print export lines for this operator's publish
                                                 identity (JINN_LAYER_PRIVATE_KEY/_SAFE_ADDRESS/
                                                 _AGENT_ID) derived from ~/.jinn-client:
                                                 eval "\$(jinn-layer derive-env)" then
                                                 jinn-layer publish. Reads the keystore +
                                                 password; the key stays in-process (stdout only,
                                                 never on disk)
  seed plan --source <list-file> [--out <report-file>] [--json]
                                                 Fetch + licence-check the disclosed seed list
                                                 (owner/repo[#path] per line); ZERO writes —
                                                 the report is what a human approves
  seed execute <report-file> --source <list-file> [--json]
                                                 Publish the approved import rows (APPROVAL
                                                 GATE: run only after the plan report is
                                                 signed off)
  distill run [--limit N] [--out <dir>] [--meta]
              [--distiller claude|codex] [--local-only]
                                                 Run the distillation pipeline over the
                                                 swe-rebench-v2 verdict ledger: verdict→solution
                                                 join → distil → local SKILL.md packages.
                                                 Held-out slate instances are excluded. Writes
                                                 <out>/<name>/SKILL.md and prints the summary.
                                                 --meta also runs stage-2 cross-instance
                                                 meta-distill over the stage-1 skills.
                                                 --local-only avoids chain writes and evidence
                                                 anchors, using in-memory publish deps.
  distil [--where local|defer|off] [--install all|<name>|none] [--resume]
         [--captures <dir>] [--limit N] [--out <dir>]
         [--distiller claude|codex] [--distiller-model <model>] [--json]
                                                 Rung-1 own-captures loop: distil YOUR recent local
                                                 captures into skills, fully local (no corpus publish,
                                                 no chain anchor). A heavy local pass, so you control
                                                 WHERE it runs (#1490):
                                                   --where local  distil here now (a spend; confirms)
                                                   --where defer  hold captures, run nothing (default)
                                                   --where off    stop reserving captures
                                                 --where sets the persistent mode and echoes it —
                                                 nothing runs. A bare 'distil' with no recorded mode
                                                 shows first-run consent (interactive) or takes the
                                                 safe default (defer) non-interactively.
                                                 A LOCAL run distils to a STAGING area and installs
                                                 NOTHING by default — you review the skills (what each
                                                 came from and will help with) and choose:
                                                   --install all     install every distilled skill
                                                   --install <name>  install just that one
                                                   --install none    stage only (default)
                                                 Interactively (TTY) the same choice is an [A]ll /
                                                 [1] first / [S]kip prompt. Installed skills land as
                                                 <out>/<name>/SKILL.md (default
                                                 ~/.jinn-client/harness-layer/skills, the active dir
                                                 /jinn skills reads); the rest wait in <out>-staged.
                                                 --resume distils only the captures no distilled skill
                                                 (installed OR staged) already covers.
                                                 --json reports the distilled and installed sets
                                                 separately.
                                                 --distiller-model is the arbitrage knob: it is the
                                                 model that WRITES the skills, distinct from the
                                                 cheap runtime model your captures ran under.

Environment:
  JINN_DISCOVERY_URL       Override the discovery indexer URL (default: testnet Ponder indexer)
  JINN_IPFS_GATEWAY_URL    Override the IPFS gateway (default: https://gateway.autonolas.tech)

Environment (publish — testnet anchor identity):
  JINN_EARNING_DIR              Earning dir derive-env reads (default: ~/.jinn-client/earning)
  JINN_LAYER_PRIVATE_KEY        Operator agent EOA key (required; signs envelope + anchor tx)
  JINN_LAYER_SAFE_ADDRESS       Operator Safe address (required)
  JINN_LAYER_AGENT_ID           ERC-8004 agent NFT id (required)
  JINN_RPC_URL                  Base Sepolia RPC (default: publicnode)
  JINN_LAYER_IDENTITY_REGISTRY  IdentityRegistry address (default: Base Sepolia 0x8004A818…BD9e)
  JINN_IPFS_REGISTRY_URL        IPFS registry for uploads (default: https://registry.autonolas.tech)
  JINN_LAYER_ENDPOINT           Artifact access endpoint recorded on publish (default: http://127.0.0.1:7331)
  JINN_LAYER_LEDGER_PATH        Ledger file (default: ~/.jinn-client/harness-layer/ledger.jsonl)

Environment (distill — reads the testnet ledger + spends model solves):
  JINN_DISCOVERY_URL       Ponder indexer base (default: testnet jinn-indexer)
  JINN_IPFS_GATEWAY_URL    IPFS gateway for envelope fetches (default: https://gateway.autonolas.tech)
  JINN_DISTILL_PROVIDER    Distiller provider: claude or codex (default: claude)
  JINN_DISTILL_MODEL       Distiller model (defaults: claude-opus-4-8 for claude, gpt-5.5 for codex)
  (publish env above)      distill also captures + anchors the bridged evidence on testnet unless --local-only

Environment (distil — the rung-1 own-captures loop; runs fully locally):
  JINN_LAYER_CAPTURES_DIR    Own-captures dir (default: ~/.jinn-client/harness-layer/captures)
  JINN_LAYER_DISTIL_MODE_PATH  Where-it-runs mode file (default: ~/.jinn-client/harness-layer/distil.json)
  JINN_DISTILL_PROVIDER      Distiller provider: claude or codex (default: claude)
  JINN_DISTILL_MODEL         Distiller model (overridden by --distiller-model)
`;

export type DistillProvider = 'claude' | 'codex';

interface DistillPorts {
  distill: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  metaDistill: (cluster: MetaCluster) => Promise<MetaDistillLLMOutput>;
}

/** Injectable deps for `distill run` (tests). Production defaults build the live wiring. */
export interface DistillCliDeps {
  /** Ledger verdict-row source (both polarities). Default: live indexer. */
  verdictSource?: VerdictSource;
  /** Fetch the patch + problem statement for an attempt. Default: live gateway + indexer. */
  fetchEvidence?: (ref: AttemptRef) => Promise<BridgeEvidence>;
  /** The LLM distill port. Default: createClaudeDistiller. */
  distill?: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  /** The stage-2 meta LLM port. Default: createClaudeMetaDistiller. */
  metaDistill?: (cluster: MetaCluster) => Promise<MetaDistillLLMOutput>;
  /** Provider-aware port factory (tests/embedders). Default: Claude or Codex CLI ports. */
  distillerFactory?: (provider: DistillProvider, model: string) => DistillPorts;
  /** Layer-1 evidence publish deps. Default: live testnet wiring from env. */
  publishDeps?: HarnessPublishDeps;
  /** Held-out slate instance ids. Default: the active swe-rebench-v2 slate. */
  slateInstanceIds?: Set<string>;
}

/**
 * Injectable deps for the rung-1 `distil` own-captures loop (tests). Production
 * defaults resolve the distill port from the provider + distiller model.
 */
export interface DistilCliDeps {
  /** The LLM distill port. Default: provider factory over the resolved distiller model. */
  distill?: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  /** Provider-aware port factory (tests). Default: Claude or Codex CLI ports. */
  distillerFactory?: (provider: DistillProvider, model: string) => DistillPorts;
  /**
   * Held-out slate ids — defence-in-depth over the gate + contamination scan.
   * Own captures rarely intersect a public slate, so this defaults to empty.
   */
  slateInstanceIds?: Set<string>;
  /**
   * First-run consent resolver (#1490). Called only when the persisted mode is
   * `unset` and the invocation is interactive. Tests inject a fake so the
   * consent flow needs no TTY; the default is a readline prompt (see
   * {@link readlineConsentPrompt}), used only when `isTty`.
   */
  promptConsent?: () => Promise<DistilMode>;
  /**
   * Whether to treat this invocation as interactive (tests). Default:
   * `process.stdout.isTTY && process.stdin.isTTY`. When false and the mode is
   * unset, the first run takes the safe default (defer) without persisting — a
   * later interactive run still gets the prompt. It also gates the install
   * review/prompt: non-interactive stages only (nothing installed).
   */
  isTty?: boolean;
  /**
   * Install-choice resolver (#1490). Called only when a LOCAL run produced
   * skills, no `--install` flag was given, and the invocation is interactive.
   * Returns the choice over the produced skill names. Tests inject a fake; the
   * default is a readline prompt (see {@link readlineInstallPrompt}).
   */
  promptInstall?: (skillNames: string[]) => Promise<InstallChoice>;
}

/** The install-review choice: everything, just the first, or none (stage only). */
export type InstallChoice = 'all' | 'first' | 'none';

export interface RunJinnLayerCliOptions {
  /** Injectable layer (tests). Default: createHarnessLayer() with env overrides. */
  layer?: HarnessLayer;
  /** Injectable publish deps (tests). Default: live testnet wiring from env. */
  publishDeps?: HarnessPublishDeps;
  /** Injectable seed source (tests). Default: GitHub source over --source list. */
  seedSource?: SeedSource;
  /** Injectable distill-pipeline deps (tests). Default: live wiring per field. */
  distillDeps?: DistillCliDeps;
  /** Injectable rung-1 own-captures deps (tests). Default: provider-resolved distill port. */
  distilDeps?: DistilCliDeps;
  writer?: { write: (s: string) => boolean };
}

const DEFAULT_CLI_SEARCH_LIMIT = 20;
/**
 * `distill run` fetches the whole verdict corpus so per-instance attempt groups
 * are complete (#1478) — the 20-row search default would silently truncate
 * groups. Only an EXPLICIT `--limit` overrides this; the verdict source pages up
 * to 20k rows, so this covers the current corpus with headroom.
 */
const DEFAULT_DISTILL_LIMIT = 2000;

/**
 * Byte ceiling on any single IPFS object fetched by the distill pipeline
 * (PR #1476 security review): envelopes are KBs; donation-wrapped
 * system_snapshots observed live are ≤ ~400 KB. 64 MiB leaves generous
 * headroom while preventing a malicious multi-GB wrapper from OOMing the run.
 */
const MAX_IPFS_FETCH_BYTES = 64 * 1024 * 1024;

/**
 * Default install directory name for `skills install`: a safe slug of the
 * publisher-controlled skill name (#1394). The name is corpus data, never a
 * path — anything outside [a-z0-9._-] collapses to '-', leading/trailing
 * dots and dashes are stripped, and an empty result falls back to 'skill'.
 */
function skillDirSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug === '' ? 'skill' : slug;
}

/** Where the persisted `distil` mode lives; env-overridable for tests / CI. */
function distilModePath(): string {
  return process.env['JINN_LAYER_DISTIL_MODE_PATH'] ?? DEFAULT_DISTIL_MODE_PATH;
}

function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a)));
}

/**
 * The default (TTY-only) first-run consent prompt. Prints the disclosure, then a
 * one-line readline menu — L(ocal, confirmed) · F/blank (defer, the safe
 * default) · O(ff) · P(review). Mirrors `cli/commands/auth.ts`'s readline
 * pattern; the keyboard state-machine in the 1490 mockup is a visual spec, not a
 * raw-mode TUI. Not unit-tested (tests inject `promptConsent`); kept small.
 */
async function readlineConsentPrompt(o: {
  captureCount: number;
  distillModel: string;
  capturesDir: string;
  captures: CapturedTask[];
  writer: { write: (s: string) => boolean };
}): Promise<DistilMode> {
  o.writer.write(renderConsentDisclosure({ captureCount: o.captureCount, distillModel: o.distillModel }) + '\n');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    for (;;) {
      const a = (await ask(rl, '\ndistil where? [L]ocal now · [F] defer (default) · [O]ff · [P]review: ')).trim().toLowerCase();
      if (a === '' || a === 'f' || a === 'defer') return 'defer';
      if (a === 'o' || a === 'off') return 'off';
      if (a === 'p' || a === 'preview') {
        o.writer.write(
          renderPreview({
            captures: o.captures.map((c) => ({ summary: c.task.summary, when: '', size: '' })),
            distillModel: o.distillModel,
          }) + '\n',
        );
        continue;
      }
      if (a === 'l' || a === 'local') {
        o.writer.write(renderConfirmLocal({ captureCount: o.captureCount, distillModel: o.distillModel }) + '\n');
        const c = (await ask(rl, '\nRun a frontier pass now? [y/N]: ')).trim().toLowerCase();
        if (c === 'y' || c === 'yes') return 'local';
        // Anything else backs out to the menu — a spend is never the default.
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * The default (TTY-only) install-review prompt. Prints the forward-framed review
 * (what each skill will help with next), then reads an explicit all / one / skip
 * choice. Same proportionate ladder as consent; nothing installs until the
 * operator answers. Not unit-tested (tests inject `promptInstall`).
 */
async function readlineInstallPrompt(o: {
  distillModel: string;
  captureCount: number;
  skills: RenderedSkill[];
  writer: { write: (s: string) => boolean };
}): Promise<InstallChoice> {
  o.writer.write(
    renderReview({ distillModel: o.distillModel, captureCount: o.captureCount, skills: o.skills }) + '\n',
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    for (;;) {
      const a = (await ask(rl, '\ninstall? [A]ll · [1] just the first · [S]kip (default): ')).trim().toLowerCase();
      if (a === '' || a === 's' || a === 'skip') return 'none';
      if (a === 'a' || a === 'all') return 'all';
      if (a === '1' || a === 'first' || a === 'one') return 'first';
      // Unrecognised → re-ask; skip is the safe default on empty.
    }
  } finally {
    rl.close();
  }
}

/**
 * Render an envelope `generatedAt` as ISO. Producers are inconsistent about
 * unit — most stamp unix seconds, some stamp milliseconds — so use the usual
 * magnitude heuristic (>= 1e12 means it cannot be seconds until year 33658).
 */
function generatedAtIso(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const ms = value >= 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function renderHit(hit: CorpusSearchHit): string {
  const lines = [
    hit.title,
    `  ref            ${hit.ref}`,
    `  operator       agentId=${hit.operator.agentId || '-'} safe=${hit.operator.safeAddress || '-'}`,
    `  evidence tier  ${hit.evidenceTier}`,
    `  generated at   ${generatedAtIso(hit.generatedAt)}`,
    // publishedAt is backing-dependent (block number on the HTTP indexer,
    // unix time elsewhere) — print raw, never as a date.
    `  published      ${hit.publishedAt}`,
    `  task           ${hit.task ? hit.task.cid : '-'}`,
    `  artifacts      ${hit.artifactTypes.join(', ') || '-'}`,
  ];
  return lines.join('\n');
}

const CONTENT_PREVIEW_BYTES = 2000;

function renderRecord(record: CorpusRecord, outDir?: string): string {
  const lines = [
    `${record.envelope.solverType} / ${record.envelope.role}`,
    `  ref            ${record.ref}`,
    `  operator       agentId=${record.provenance.operator.agentId || '-'} safe=${record.provenance.operator.safeAddress || '-'}`,
    `  evidence tier  ${record.provenance.evidenceTier}`,
    `  published      ${record.provenance.publishedAt}`,
    '',
    `${record.artifacts.length} artifact(s)`,
  ];
  for (const a of record.artifacts) {
    lines.push(
      '',
      `artifact ${a.sha256}`,
      `  type    ${a.artifactType}`,
      `  size    ${a.sizeBytes} bytes`,
      `  source  ${a.source}`,
    );
    if (outDir) {
      const path = join(outDir, a.sha256);
      writeFileSync(path, a.content);
      lines.push(`  saved   ${path}`);
    } else {
      const preview = a.content.subarray(0, CONTENT_PREVIEW_BYTES).toString('utf-8');
      const truncated = a.sizeBytes > CONTENT_PREVIEW_BYTES ? `\n  … truncated (${a.sizeBytes} bytes total; use --out <dir> for full content)` : '';
      lines.push(`  content:\n${preview}${truncated}`);
    }
  }
  return lines.join('\n');
}

function recordToJson(record: CorpusRecord): unknown {
  return {
    ...record,
    artifacts: record.artifacts.map((a) => ({
      sha256: a.sha256,
      artifactType: a.artifactType,
      source: a.source,
      sizeBytes: a.sizeBytes,
      contentBase64: a.content.toString('base64'),
    })),
  };
}

/** Cap displayed before/after values so one huge attribute stays readable. */
const DIFF_VALUE_PREVIEW_CHARS = 400;

function renderDiffValue(value: unknown): string {
  if (value === undefined) return '(dropped — field is not published at all)';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = s.replace(/\n/g, '\\n');
  return flat.length > DIFF_VALUE_PREVIEW_CHARS
    ? `${flat.slice(0, DIFF_VALUE_PREVIEW_CHARS)}… (${flat.length} chars)`
    : flat;
}

/**
 * Group redaction entries by field: the pipeline reports one entry per
 * detection, so a busy attribute produces many entries with identical
 * before/after — one block per field with the union of firing stages is the
 * readable audit view.
 */
function renderRedactionsByField(redactions: ScrubRedaction[]): string[] {
  const byField = new Map<string, ScrubRedaction[]>();
  for (const r of redactions) {
    const group = byField.get(r.field) ?? [];
    group.push(r);
    byField.set(r.field, group);
  }
  const lines: string[] = [];
  for (const [field, group] of byField) {
    const stages = [...new Set(group.map((r) => `${r.stage}${r.detail ? ` (${r.detail})` : ''}`))];
    const first = group[0]!;
    const last = group[group.length - 1]!;
    lines.push(`  ${field}`);
    lines.push(`    stages   ${stages.join(', ')}`);
    if ('before' in first) lines.push(`    before   ${renderDiffValue(first.before)}`);
    lines.push(`    after    ${renderDiffValue(last.after)}`);
    lines.push('');
  }
  lines.pop(); // trailing blank
  return lines;
}

function renderScrubReport(report: ScrubReport): string {
  const truncated = report.envelope.steps.reduce(
    (n, s) => n + (s.truncatedKeys?.length ?? 0),
    0,
  );
  const lines = [
    'scrub preview — what would leave this machine',
    `  task     ${report.envelope.task.summary}`,
    `  steps    ${report.envelope.steps.length}`,
    `  scrub    ${report.redactions.length} redaction(s), ${truncated} truncation receipt(s)`,
    '',
  ];
  if (report.redactions.length === 0) {
    lines.push('no redactions — the scrub pipeline found nothing to remove');
  } else {
    lines.push(
      `${report.redactions.length} redaction(s) — "before" is shown here only and never leaves this machine`,
      '',
      ...renderRedactionsByField(report.redactions),
    );
  }
  lines.push(
    '',
    'envelope as it would publish:',
    JSON.stringify(report.envelope, null, 2),
  );
  return lines.join('\n');
}

/** Base Sepolia explorer — the testnet all v0 anchors land on. */
const TESTNET_EXPLORER_TX_URL = 'https://sepolia.basescan.org/tx/';

function renderLedgerEntry(entry: LedgerEntry): string {
  const lines = [
    `${entry.ts}  ${entry.status}`,
    `  task      ${entry.taskSummary}`,
    `  tier      ${entry.verifiabilityTier}`,
    `  ref       ${entry.envelopeRef ?? '- (not published)'}`,
    `  anchor    ${entry.anchorTx ? `${TESTNET_EXPLORER_TX_URL}${entry.anchorTx}` : '-'}`,
  ];
  return lines.join('\n');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`publish requires ${name} to be set (see \`jinn-layer help\` for the publish environment)`);
  }
  return value;
}

/** Live testnet publish deps from JINN_LAYER_* env (see USAGE). */
function buildLivePublishDepsFromEnv(): HarnessPublishDeps {
  return createLivePublishDeps({
    privateKey: requireEnv('JINN_LAYER_PRIVATE_KEY') as `0x${string}`,
    safeAddress: requireEnv('JINN_LAYER_SAFE_ADDRESS') as `0x${string}`,
    agentId: BigInt(requireEnv('JINN_LAYER_AGENT_ID')),
    ...(process.env['JINN_RPC_URL'] ? { rpcUrl: process.env['JINN_RPC_URL'] } : {}),
    ...(process.env['JINN_LAYER_IDENTITY_REGISTRY']
      ? { identityRegistry: process.env['JINN_LAYER_IDENTITY_REGISTRY'] as `0x${string}` }
      : {}),
    ...(process.env['JINN_IPFS_REGISTRY_URL'] ? { ipfsRegistryUrl: process.env['JINN_IPFS_REGISTRY_URL'] } : {}),
    ...(process.env['JINN_LAYER_ENDPOINT'] ? { endpoint: process.env['JINN_LAYER_ENDPOINT'] } : {}),
    ...(process.env['JINN_LAYER_LEDGER_PATH'] ? { ledgerPath: process.env['JINN_LAYER_LEDGER_PATH'] } : {}),
  });
}

function buildLocalOnlyPublishDeps(): HarnessPublishDeps {
  let n = 0;
  const nextLocalCid = (kind: string) => `local:${kind}:${++n}`;
  return {
    participant: { safeAddress: `0x${'1'.repeat(40)}`, agentEoa: `0x${'2'.repeat(40)}` },
    signer: { address: `0x${'2'.repeat(40)}` },
    clientGitSha: 'local-only',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async () => ({ cid: nextLocalCid('artifact') }),
    publishEnvelope: async () => ({ cid: nextLocalCid('envelope') }),
    anchorEnvelope: async () => ({ blockNumber: null }),
    signEnvelope: async () => ({
      algo: 'secp256k1',
      signer: `0x${'2'.repeat(40)}`,
      hash: `0x${'0'.repeat(64)}`,
      sig: `0x${'f'.repeat(130)}`,
    }),
  };
}

function parseDistillProvider(raw: string): DistillProvider | null {
  return raw === 'claude' || raw === 'codex' ? raw : null;
}

function defaultDistillerFactory(provider: DistillProvider, model: string): DistillPorts {
  if (provider === 'codex') {
    return {
      distill: createCodexDistiller({ model }),
      metaDistill: createCodexMetaDistiller({ model }),
    };
  }
  return {
    distill: createClaudeDistiller({ model }),
    metaDistill: createClaudeMetaDistiller({ model }),
  };
}

function buildDefaultLayer(): HarnessLayer {
  return createHarnessLayer({
    ...(process.env['JINN_DISCOVERY_URL'] ? { discoveryUrl: process.env['JINN_DISCOVERY_URL'] } : {}),
    ...(process.env['JINN_IPFS_GATEWAY_URL'] ? { ipfsGatewayUrl: process.env['JINN_IPFS_GATEWAY_URL'] } : {}),
  });
}

/** Returns the process exit code (0 = success). */
export async function runJinnLayerCli(
  argv: string[],
  opts: RunJinnLayerCliOptions = {},
): Promise<number> {
  const writer = opts.writer ?? process.stdout;
  const [verb, subverb, ...rest] = argv;

  const isCorpus = verb === 'corpus' && (subverb === 'search' || subverb === 'get');
  const isCapturePreview = verb === 'capture' && subverb === 'preview';
  const isLedger = verb === 'ledger';
  const isPublish = verb === 'publish';
  const isSeed = verb === 'seed' && (subverb === 'plan' || subverb === 'execute');
  const isSkillsInstall = verb === 'skills' && subverb === 'install';
  const isDistill = verb === 'distill' && subverb === 'run';
  const isDistil = verb === 'distil';
  const isDeriveEnv = verb === 'derive-env';
  if (!isCorpus && !isCapturePreview && !isLedger && !isPublish && !isSeed && !isSkillsInstall && !isDistill && !isDistil && !isDeriveEnv) {
    writer.write(USAGE);
    return verb === undefined || verb === 'help' || verb === '--help' ? 0 : 2;
  }

  // `ledger`, `publish`, `distil`, and `derive-env` have no subverb — their args start at argv[1].
  const flat = isLedger || isPublish || isDistil || isDeriveEnv;
  let parsed;
  try {
    parsed = parseArgs({
      args: flat ? (subverb === undefined ? rest : [subverb, ...rest]) : rest,
      options: {
        limit: { type: 'string', default: String(DEFAULT_CLI_SEARCH_LIMIT) },
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
        path: { type: 'string' },
        veto: { type: 'boolean', default: false },
        source: { type: 'string' },
        meta: { type: 'boolean', default: false },
        distiller: { type: 'string' },
        'distiller-model': { type: 'string' },
        captures: { type: 'string' },
        'local-only': { type: 'boolean', default: false },
        where: { type: 'string' },
        resume: { type: 'boolean', default: false },
        install: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch (err) {
    writer.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }

  if (isCapturePreview) {
    const taskFile = parsed.positionals[0];
    if (taskFile === undefined) {
      writer.write(`error: capture preview requires a <task-file> argument (a captured-task JSON file)\n\n${USAGE}`);
      return 2;
    }
    const task = parseCapturedTask(JSON.parse(readFileSync(taskFile, 'utf-8')));
    const report = preview(await capture(task));
    if (parsed.values.json) {
      // Persistence-safe projection: --json output may be piped to disk, so
      // the original (pre-scrub) values are stripped — they are for the
      // operator's eyes on their own terminal only.
      writer.write(JSON.stringify({
        envelope: report.envelope,
        redactions: stripBeforeValues(report.redactions),
      }) + '\n');
    } else {
      writer.write(renderScrubReport(report) + '\n');
    }
    return 0;
  }

  if (isSeed) {
    const buildSource = (): SeedSource => {
      if (opts.seedSource) return opts.seedSource;
      const listFile = parsed.values.source as string | undefined;
      if (!listFile) {
        throw new Error('seed commands require --source <list-file> (owner/repo[#path] per line) or an injected source');
      }
      const entries = readFileSync(listFile, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map(parseSeedListEntry);
      return createGithubSeedSource({
        entries,
        ...(process.env['GITHUB_TOKEN'] ? { token: process.env['GITHUB_TOKEN'] } : {}),
      });
    };

    if (subverb === 'plan') {
      const report = await seedPlan(buildSource());
      const outFile = parsed.values.out as string | undefined;
      if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
      if (parsed.values.json) {
        writer.write(JSON.stringify(report) + '\n');
      } else {
        writer.write(renderImportReport(report) + '\n');
        writer.write(outFile
          ? `\nReport written to ${outFile}. APPROVAL GATE: review (edit verdicts if needed), then run seed execute ${outFile}.\n`
          : '\nAPPROVAL GATE: re-run with --out <report-file>, review, then seed execute.\n');
      }
      return 0;
    }

    // seed execute <report-file>
    const reportFile = parsed.positionals[0];
    if (reportFile === undefined) {
      writer.write(`error: seed execute requires a <report-file> argument (the approved plan report)\n\n${USAGE}`);
      return 2;
    }
    const report = parseImportReport(JSON.parse(readFileSync(reportFile, 'utf-8')));
    const deps = opts.publishDeps ?? buildLivePublishDepsFromEnv();
    const result = await seedExecute(report, buildSource(), deps);
    if (parsed.values.json) {
      writer.write(JSON.stringify(result) + '\n');
    } else {
      const lines = [
        `${result.imported.length} imported, ${result.skipped.length} skipped, ${result.errors.length} error(s)`,
      ];
      for (const row of result.imported) {
        lines.push(`  IMPORTED ${row.skill}`, `    ref     ${row.envelopeRef}`, `    anchor  ${row.anchorTx ? `${TESTNET_EXPLORER_TX_URL}${row.anchorTx}` : '-'}`);
      }
      for (const row of result.skipped) lines.push(`  skipped  ${row.skill} — ${row.reason}`);
      for (const row of result.errors) lines.push(`  ERROR    ${row.skill} — ${row.error}`);
      writer.write(lines.join('\n') + '\n');
    }
    return result.errors.length > 0 ? 1 : 0;
  }

  if (isDistil) {
    const dd = opts.distilDeps ?? {};
    const json = parsed.values.json as boolean;

    // Distiller provider + model — the arbitrage knob. The model resolved here
    // WRITES the skills; it is deliberately distinct from the cheap runtime
    // model each capture ran under (`environment.model`), which `distil` never
    // touches. Resolution: --distiller-model > JINN_DISTILL_MODEL > provider default.
    const rawProvider = (parsed.values.distiller as string | undefined) ?? process.env['JINN_DISTILL_PROVIDER'] ?? 'claude';
    const distillProvider = parseDistillProvider(rawProvider);
    if (!distillProvider) {
      writer.write(`error: distiller must be "claude" or "codex" (got ${JSON.stringify(rawProvider)})\n\n${USAGE}`);
      return 2;
    }
    const defaultDistillModel = distillProvider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_DISTILL_MODEL;
    const distillModel =
      (parsed.values['distiller-model'] as string | undefined) ??
      process.env['JINN_DISTILL_MODEL'] ??
      defaultDistillModel;
    const distill =
      dd.distill ?? (dd.distillerFactory ?? defaultDistillerFactory)(distillProvider, distillModel).distill;

    const modePath = distilModePath();

    // 1c — `--where <mode>`: the persistent setter. Scriptable, non-interactive;
    // it records the mode and echoes the resulting behaviour, and runs nothing.
    const whereFlag = parsed.values.where as string | undefined;
    if (whereFlag !== undefined) {
      if (whereFlag !== 'local' && whereFlag !== 'defer' && whereFlag !== 'off') {
        writer.write(`error: --where must be "local", "defer" or "off" (got ${JSON.stringify(whereFlag)})\n\n${USAGE}`);
        return 2;
      }
      writeDistilMode(whereFlag, modePath);
      writer.write((json ? JSON.stringify({ where: whereFlag }) : renderModeSet(whereFlag)) + '\n');
      return 0;
    }

    // Source: recent OWN captures (default ~/.jinn-client/harness-layer/captures).
    const capturesDir =
      (parsed.values.captures as string | undefined) ??
      process.env['JINN_LAYER_CAPTURES_DIR'] ??
      DEFAULT_CAPTURES_DIR;
    const capN = Number.parseInt(parsed.values.limit as string, 10);
    const capLimit =
      argv.some((a) => a === '--limit' || a.startsWith('--limit=')) && Number.isFinite(capN) && capN > 0
        ? capN
        : DEFAULT_DISTIL_CAPTURE_LIMIT;
    const captures = loadRecentCaptures(capturesDir, capLimit);

    // 1d — empty: nothing to distil, whatever the mode. Short-circuits consent.
    if (captures.length === 0) {
      if (json) {
        writer.write(JSON.stringify({ clusterCount: 0, distilled: { published: [], rejected: [], errors: [] }, capturesConsidered: 0, distillModel }) + '\n');
      } else {
        writer.write(renderEmpty({ capturesDir }) + '\n');
      }
      return 0;
    }

    const resume = parsed.values.resume as boolean;
    const mode = readDistilMode(modePath);
    const isTty = dd.isTty ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);

    // Decide the mode this invocation acts on. `--resume` only continues an
    // already-consented LOCAL run — it never grants consent itself, so a
    // `--resume` under any other mode falls through to normal mode handling
    // (unset → first-run consent, defer/off → run nothing). This closes the
    // bypass where `distil --resume` on a fresh machine would spend without ever
    // passing the consent gate.
    let acting: DistilMode;
    if (resume && mode === 'local') {
      acting = 'local';
    } else if (mode === 'unset') {
      const prompt =
        dd.promptConsent ??
        (isTty
          ? () => readlineConsentPrompt({ captureCount: captures.length, distillModel, capturesDir, captures, writer })
          : undefined);
      if (!prompt) {
        // Non-interactive first run: the safe default is defer, and it is NOT
        // persisted — a later interactive run still gets the consent prompt.
        if (json) {
          writer.write(JSON.stringify({ mode: 'defer', ran: false, consent: 'unset', capturesConsidered: captures.length }) + '\n');
        } else {
          writer.write(renderConsentDisclosure({ captureCount: captures.length, distillModel }) + '\n\n');
          writer.write(renderDeferredRun({ captureCount: captures.length, capturesDir }) + '\n');
        }
        return 0;
      }
      const chosen = await prompt();
      writeDistilMode(chosen, modePath);
      writer.write(renderRecorded(chosen, { captureCount: captures.length }) + '\n');
      if (chosen !== 'local') return 0;
      acting = 'local';
    } else {
      acting = mode;
    }

    if (acting === 'off') {
      if (json) writer.write(JSON.stringify({ mode: 'off', ran: false, capturesConsidered: captures.length }) + '\n');
      else writer.write(renderRecorded('off', { captureCount: captures.length }) + '\n');
      return 0;
    }
    if (acting === 'defer') {
      if (json) writer.write(JSON.stringify({ mode: 'defer', ran: false, capturesConsidered: captures.length }) + '\n');
      else writer.write(renderDeferredRun({ captureCount: captures.length, capturesDir }) + '\n');
      return 0;
    }

    // acting === 'local' → distil to STAGING, review, install-on-choice.
    // `--out` is the ACTIVE skills dir (installed skills live here — what /jinn
    // skills and resume read). Distilled-but-not-installed skills wait in a
    // sibling staging dir until the operator installs them; nothing goes live
    // without an explicit choice (the consent-consistent default).
    const activeDir = (parsed.values.out as string | undefined) ?? DEFAULT_SKILLS_INSTALL_DIR;
    const stagingDir = stagingDirFor(activeDir);
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });

    // --resume: distil only captures no distilled skill (installed OR staged)
    // already covers.
    let toDistil = captures;
    if (resume) {
      const covered = coveredSessionIds([activeDir, stagingDir]);
      toDistil = captures.filter((c) => !covered.has(c.session.sessionId));
      if (toDistil.length === 0) {
        if (json) writer.write(JSON.stringify({ mode: 'local', ran: false, resume: true, capturesConsidered: captures.length }) + '\n');
        else writer.write(renderResumeNothing({ captureCount: captures.length }) + '\n');
        return 0;
      }
    }

    // Distil to STAGING — nothing is installed yet.
    const distiller = createLocalDistiller({
      distill,
      sink: createLocalSkillSink(stagingDir),
      distribution: 'coding',
      distillModel,
      ...(dd.slateInstanceIds ? { slate: { instanceIds: dd.slateInstanceIds } } : {}),
    });
    const result = await distiller.distil(toDistil);
    const published = result.distilled.published;
    const summaryBySession = new Map(toDistil.map((c) => [c.session.sessionId, c.task.summary]));

    // 1d — a run failed mid-way: staged skills are kept, point at --resume. No
    // install is offered on a partial run.
    if (result.distilled.errors.length > 0) {
      if (json) {
        writer.write(JSON.stringify({ ...result, stagingDir, activeDir, installed: [], capturesConsidered: toDistil.length, distillModel }) + '\n');
      } else {
        writer.write(renderFailure({ distillModel, distilledCount: published.length, errors: result.distilled.errors }) + '\n');
      }
      return 1;
    }

    // Resolve the install choice: --install flag > interactive review/prompt >
    // stage-only. The non-interactive default installs NOTHING — the whole point
    // of decoupling distil from install is that skills go live only on a choice.
    const publishedNames = published.map((p) => p.pkg.name);
    let installNames = new Set<string>();
    if (published.length > 0) {
      const installFlag = parsed.values.install as string | undefined;
      if (installFlag !== undefined) {
        if (installFlag === 'all') installNames = new Set(publishedNames);
        else if (installFlag === 'none') installNames = new Set();
        else if (publishedNames.includes(installFlag)) installNames = new Set([installFlag]);
        else {
          writer.write(
            `error: --install "${installFlag}" — no distilled skill by that name ` +
              `(available: ${publishedNames.join(', ')}; or "all" / "none")\n`,
          );
          return 2;
        }
      } else {
        const reviewSkills: RenderedSkill[] = published.map((p) => ({
          name: p.pkg.name,
          installed: false,
          provenance: provenanceLabels(p.pkg, summaryBySession),
          helpsWith: p.pkg.description,
        }));
        const prompt =
          dd.promptInstall ??
          (isTty
            ? () => readlineInstallPrompt({ distillModel, captureCount: toDistil.length, skills: reviewSkills, writer })
            : undefined);
        if (prompt) {
          const choice = await prompt(publishedNames);
          installNames =
            choice === 'all'
              ? new Set(publishedNames)
              : choice === 'first'
                ? new Set(publishedNames.slice(0, 1))
                : new Set();
        }
        // else non-interactive → stage only (installNames stays empty).
      }
    }

    // Install the chosen skills into the active dir via the existing local sink,
    // and clear their staged copies so staging holds only what's not installed.
    const activeSink = createLocalSkillSink(activeDir);
    for (const p of published) {
      if (!installNames.has(p.pkg.name)) continue;
      await activeSink(p.pkg);
      rmSync(join(stagingDir, p.pkg.name), { recursive: true, force: true });
    }

    if (json) {
      writer.write(JSON.stringify({
        ...result,
        stagingDir,
        activeDir,
        installed: [...installNames],
        capturesConsidered: toDistil.length,
        distillModel,
      }) + '\n');
    } else {
      // 1b — the outcome panel: each distilled skill with its actual install
      // state, forward `helps` value, and `from` provenance.
      const skills: RenderedSkill[] = published.map((p) => ({
        name: p.pkg.name,
        installed: installNames.has(p.pkg.name),
        provenance: provenanceLabels(p.pkg, summaryBySession),
        helpsWith: p.pkg.description,
      }));
      writer.write(renderRunSummary({ distillModel, captureCount: toDistil.length, skills }) + '\n');
    }
    return 0;
  }

  if (isDistill) {
    const dd = opts.distillDeps ?? {};

    // Only honor an EXPLICIT --limit; otherwise fetch the corpus broadly so
    // attempt groups stay complete (#1478) rather than inheriting the 20-row
    // search default (which silently truncates groups mid-instance).
    const userSetLimit = rest.some((a) => a === '--limit' || a.startsWith('--limit='));
    const n = Number.parseInt(parsed.values.limit as string, 10);
    const limit = userSetLimit && Number.isFinite(n) && n > 0 ? n : DEFAULT_DISTILL_LIMIT;

    const outDir = (parsed.values.out as string | undefined) ?? mkdtempSync(join(tmpdir(), 'jinn-distill-'));
    mkdirSync(outDir, { recursive: true });
    const localOnly = parsed.values['local-only'] as boolean;

    const rawProvider = (parsed.values.distiller as string | undefined) ?? process.env['JINN_DISTILL_PROVIDER'] ?? 'claude';
    const distillProvider = parseDistillProvider(rawProvider);
    if (!distillProvider) {
      writer.write(`error: distiller must be "claude" or "codex" (got ${JSON.stringify(rawProvider)})\n\n${USAGE}`);
      return 2;
    }

    const slateInstanceIds =
      dd.slateInstanceIds ?? loadActiveHeldOutSlateIds('swe-rebench-v2.v1', ACTIVE_HELD_OUT_SLATE_VERSIONS);

    // Verdict source over the testnet indexer (default) unless one is injected.
    const verdictSource =
      dd.verdictSource ??
      createVerdictSource({
        graphqlUrl: process.env['JINN_DISCOVERY_URL'] ?? DEFAULT_TESTNET_DISCOVERY_URL,
      });

    // The evidence fetcher's live ports: autonolas gateway + Ponder GraphQL.
    // Injected in tests; built from env here (mirrors distill-run-live.ts).
    const fetchEvidence =
      dd.fetchEvidence ??
      (() => {
        const gateway = (process.env['JINN_IPFS_GATEWAY_URL'] ?? DEFAULT_IPFS_GATEWAY_URL).replace(/\/$/, '');
        const base = (process.env['JINN_DISCOVERY_URL'] ?? DEFAULT_TESTNET_DISCOVERY_URL).replace(/\/$/, '');
        const graphqlUrl = base.endsWith('/graphql') ? base : `${base}/graphql`;
        return createEvidenceFetcher({
          ipfs: async (cid: string) => {
            const res = await fetch(`${gateway}/ipfs/${cid}`, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(`ipfs ${cid}: HTTP ${res.status}`);
            // Byte ceiling on attacker-published IPFS objects (system_snapshot
            // wrappers are the large hop): res.json() would buffer unboundedly.
            const buf = await res.arrayBuffer();
            if (buf.byteLength > MAX_IPFS_FETCH_BYTES) {
              throw new Error(`ipfs ${cid}: ${buf.byteLength} bytes exceeds the ${MAX_IPFS_FETCH_BYTES}-byte fetch ceiling`);
            }
            return JSON.parse(Buffer.from(buf).toString('utf8'));
          },
          gql: async (query: string) => {
            const res = await fetch(graphqlUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query }),
            });
            const body = (await res.json()) as { data?: unknown; errors?: unknown };
            if (body.errors) throw new Error(`gql: ${JSON.stringify(body.errors)}`);
            return body.data;
          },
        });
      })();

    // Resolve the distiller model once — it drives BOTH the model call and the
    // `distillModel` recorded in provenance (§5), so the record matches the run.
    const defaultDistillModel = distillProvider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_DISTILL_MODEL;
    const distillModel = process.env['JINN_DISTILL_MODEL'] ?? defaultDistillModel;
    const distillerFactory = dd.distillerFactory ?? defaultDistillerFactory;
    const distillPorts = dd.distill && dd.metaDistill ? null : distillerFactory(distillProvider, distillModel);
    const distill = dd.distill ?? distillPorts!.distill;
    const metaEnabled = parsed.values.meta as boolean;
    const metaDistillPort = dd.metaDistill ?? distillPorts!.metaDistill;
    const publishDeps = localOnly ? buildLocalOnlyPublishDeps() : (dd.publishDeps ?? buildLivePublishDepsFromEnv());

    // Local-fs publishSkill: write <out>/<name>/SKILL.md (shared with LocalDistiller).
    const publishSkill = createLocalSkillSink(outDir);

    const result = await runDistillationPipeline({
      verdictSource,
      fetchEvidence,
      distill,
      publishDeps,
      publishSkill,
      slate: { instanceIds: slateInstanceIds },
      distribution: 'coding',
      distillModel,
      ...(metaEnabled ? { meta: true, metaDistill: metaDistillPort } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    if (parsed.values.json) {
      writer.write(JSON.stringify({ ...result, outDir }) + '\n');
    } else {
      const lines = [
        `distilled: published ${result.distilled.published.length}, rejected ${result.distilled.rejected.length}, errors ${result.distilled.errors.length}`,
        `bridge: ${result.bridge.bridged.length} bridged, ${result.bridge.excludedHeldOut.length} held-out, ${result.bridge.deduped.length} deduped, ${result.bridge.errors.length} error(s)`,
        `clusters: ${result.clusterCount}`,
      ];
      if (localOnly) lines.push('mode: local-only (no chain publishes or anchors)');
      if (result.verdictsTruncated) {
        lines.push(`warning: verdict fetch hit the ${limit}-row limit — attempt groups may be PARTIAL; raise --limit to cover the corpus (#1478)`);
      }
      for (const p of result.distilled.published) lines.push(`  PUBLISHED ${p.skillKind} ${p.envelopeRef} (${p.clusterId})`);
      for (const r of result.distilled.rejected) lines.push(`  rejected  ${r.clusterId} — ${r.reason}`);
      for (const e of result.distilled.errors) lines.push(`  ERROR     ${e.clusterId} — ${e.error}`);
      if (result.metaDistilled) {
        lines.push('', `meta-distilled: published ${result.metaDistilled.published.length}, rejected ${result.metaDistilled.rejected.length}, errors ${result.metaDistilled.errors.length}`);
        for (const p of result.metaDistilled.published) {
          lines.push(`  META ${p.skillKind} ${p.envelopeRef} (${p.metaClusterId}) evidenceTokens=${p.pkg.jinn.evidenceTokens} skillTokens=${p.pkg.jinn.skillTokens}`);
        }
        for (const r of result.metaDistilled.rejected) lines.push(`  meta-rejected ${r.metaClusterId} — ${r.reason}`);
        for (const e of result.metaDistilled.errors) lines.push(`  META-ERROR ${e.metaClusterId} — ${e.error}`);
      }
      lines.push('', `skills written under: ${outDir}`);
      writer.write(lines.join('\n') + '\n');
    }
    return result.distilled.errors.length > 0 || (result.metaDistilled?.errors.length ?? 0) > 0 ? 1 : 0;
  }

  if (isDeriveEnv) {
    // Read-only replay of the daemon's identity path (client/src/main.ts
    // resolveBootstrapIdentity): read the encrypted mnemonic keystore + the
    // resolved password from the local earning dir, derive the agent key
    // in-process, and pull Safe address + agent id from persisted fleet state.
    // Prints exactly three `export …` lines to stdout for
    // `eval "$(jinn-layer derive-env)"` capture. Every failure is a one-line
    // stderr message + non-zero exit with ZERO stdout — so an error `eval`s to
    // a no-op rather than exporting partial identity.
    const err = (msg: string): number => {
      process.stderr.write(`${msg}\n`);
      return 1;
    };
    const earningDir = process.env['JINN_EARNING_DIR'] ?? DEFAULT_EARNING_DIR;
    const store = new FleetStateStore(earningDir);

    // (a) keystore guard — before anything else, zero stdout.
    if (!store.hasMnemonicKeystore()) {
      return err(
        `derive-env: no keystore at ${mnemonicKeystorePath(earningDir)} — run \`jinn run\` to bootstrap first`,
      );
    }
    // (b) password — resolveCliPassword (NO auto-generate; a read-only derive
    // must never mint a fresh password, which would derive a wrong identity).
    const pw = resolveCliPassword(argv.slice(1), process.env);
    if (!pw.ok) return err(`derive-env: ${pw.message}`);
    // (d) fleet state + first operational service (the daemon's exact selector).
    const state = await store.tryLoadExisting();
    const svc = state?.services.find((s) => isOperationalServiceStep(s.step));
    if (!svc || !svc.safe_address || !svc.agent_id) {
      return err(
        'derive-env: no fully-bootstrapped agent identity found (Safe/agent not yet registered) — finish `jinn run` bootstrap',
      );
    }
    // (c) decrypt — catch the self-verify throw so no stack trace leaks.
    let mnemonic: string;
    try {
      mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), pw.password);
    } catch {
      return err('derive-env: could not decrypt keystore (wrong password?)');
    }
    const privateKey = walletPrivateKeyAtIndex(mnemonic, svc.index);
    // stderr: the derived agent ADDRESS (never the key) so the operator can eyeball it.
    process.stderr.write(
      `derive-env: agent ${svc.agent_address} (index ${svc.index})\n`,
    );
    // stdout: exactly the three export lines — a single atomic write.
    writer.write(
      `export JINN_LAYER_PRIVATE_KEY=${privateKey}\n` +
        `export JINN_LAYER_SAFE_ADDRESS=${svc.safe_address}\n` +
        `export JINN_LAYER_AGENT_ID=${svc.agent_id}\n`,
    );
    return 0;
  }

  if (isPublish) {
    const taskFile = subverb;
    if (taskFile === undefined || taskFile.startsWith('--')) {
      writer.write(`error: publish requires a <task-file> argument (a captured-task JSON file)\n\n${USAGE}`);
      return 2;
    }
    const task = parseCapturedTask(JSON.parse(readFileSync(taskFile, 'utf-8')));
    const pending = await capture(task);
    const deps = opts.publishDeps ?? buildLivePublishDepsFromEnv();
    const result = await publish(pending, deps, { veto: parsed.values.veto as boolean });
    if (parsed.values.json) {
      writer.write(JSON.stringify(result) + '\n');
    } else if (result.vetoed) {
      writer.write('Vetoed — nothing published; recorded in the ledger as vetoed (local only).\n');
    } else {
      writer.write([
        'Published.',
        `  ref       ${result.envelopeRef}`,
        `  anchor    ${result.anchorTx ? `${TESTNET_EXPLORER_TX_URL}${result.anchorTx}` : '- (anchor tx pending)'}`,
        `  fetch it  jinn-layer corpus get ${result.envelopeRef}`,
        '',
      ].join('\n'));
    }
    return 0;
  }

  if (isLedger) {
    const path = (parsed.values.path as string | undefined) ?? DEFAULT_LEDGER_PATH;
    const entries = ledger(path);
    if (parsed.values.json) {
      writer.write(JSON.stringify(entries) + '\n');
    } else if (entries.length === 0) {
      writer.write(`No contributions yet — the ledger at ${path} is empty.\n`);
    } else {
      writer.write(`${entries.length} contribution(s)\n\n${entries.map(renderLedgerEntry).join('\n\n')}\n`);
    }
    return 0;
  }

  const layer = opts.layer ?? buildDefaultLayer();

  if (isSkillsInstall) {
    const ref = parsed.positionals[0];
    if (ref === undefined) {
      writer.write(`error: skills install requires a <ref> argument (a manifest CID from a search result)\n\n${USAGE}`);
      return 2;
    }
    const record = await layer.corpus.get(ref);
    let extracted;
    try {
      extracted = extractSkill(record);
    } catch (err) {
      writer.write(`error: record ${ref} carries a malformed jinn.skill.v1 artifact — ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    if (extracted === null) {
      writer.write(`error: record ${ref} carries no skill (neither a jinn.skill.v1 artifact nor the seeded trace shape)\n`);
      return 1;
    }
    const { skill } = extracted;
    // Default dir: a safe slug of the publisher-controlled name, contained
    // in cwd (containment is belt-and-suspenders alongside the slug; --out
    // is operator-chosen and taken as given).
    const outFlag = parsed.values.out as string | undefined;
    const dir = outFlag ?? join(process.cwd(), skillDirSlug(skill.skill.name));
    if (outFlag === undefined && !isInsidePackageDir(process.cwd(), dir)) {
      writer.write(`error: skill name ${JSON.stringify(skill.skill.name)} does not resolve to a directory inside the current directory — pass --out <dir>\n`);
      return 1;
    }
    // Verify every companion digest and resolved target BEFORE any write —
    // an aborted install must leave nothing on disk.
    const companions: { target: string; bytes: Buffer }[] = [];
    for (const file of skill.files) {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== file.sha256) {
        writer.write(`error: companion file ${file.path} sha256 mismatch (expected ${file.sha256}, got ${digest})\n`);
        return 1;
      }
      const target = join(dir, file.path);
      if (!isInsidePackageDir(dir, target)) {
        writer.write(`error: companion file ${file.path} escapes the install directory\n`);
        return 1;
      }
      companions.push({ target, bytes });
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skill.skill.skillMd);
    for (const { target, bytes } of companions) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    if (parsed.values.json) {
      writer.write(JSON.stringify({
        dir,
        name: skill.skill.name,
        shape: extracted.shape,
        files: skill.files.map((f) => f.path),
        provenance: skill.provenance,
      }) + '\n');
    } else {
      const p = skill.provenance;
      writer.write([
        `Installed ${skill.skill.name} (${extracted.shape}) to ${dir}`,
        `  files       SKILL.md${skill.files.length > 0 ? `, ${skill.files.map((f) => f.path).join(', ')}` : ''}`,
        `  provenance  ${p.kind}${p.solverType ? ` (${p.solverType})` : ''}`,
        `  operator    ${p.operator.safeAddress}`,
        `  sources     ${p.sourceEnvelopeCids.join(', ') || '-'}`,
        ...(p.seed ? [`  seed        ${p.seed.skill} — ${p.seed.source} (${p.seed.licence ?? 'no licence'})`] : []),
        '',
      ].join('\n'));
    }
    return 0;
  }

  if (subverb === 'search') {
    const query = parsed.positionals[0];
    if (query === undefined) {
      writer.write(`error: corpus search requires a <query> argument (use "" for all records)\n\n${USAGE}`);
      return 2;
    }
    const n = Number.parseInt(parsed.values.limit as string, 10);
    const limit = Math.min(Math.max(Number.isFinite(n) ? n : DEFAULT_CLI_SEARCH_LIMIT, 1), 500);
    const hits = await layer.corpus.search(query, { limit });
    if (parsed.values.json) {
      writer.write(JSON.stringify(hits) + '\n');
    } else if (hits.length === 0) {
      writer.write('No corpus records matched.\n');
    } else {
      writer.write(`${hits.length} result(s)\n\n${hits.map(renderHit).join('\n\n')}\n`);
    }
    return 0;
  }

  // corpus get
  const ref = parsed.positionals[0];
  if (ref === undefined) {
    writer.write(`error: corpus get requires a <ref> argument (a manifest CID from a search result)\n\n${USAGE}`);
    return 2;
  }
  const outDir = parsed.values.out as string | undefined;
  if (outDir) mkdirSync(outDir, { recursive: true });
  const record = await layer.corpus.get(ref);
  if (parsed.values.json) {
    writer.write(JSON.stringify(recordToJson(record)) + '\n');
  } else {
    writer.write(renderRecord(record, outDir) + '\n');
  }
  return 0;
}
