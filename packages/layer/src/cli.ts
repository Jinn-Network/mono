/**
 * jinn-layer CLI — the human surface over the harness-layer consume path.
 *
 * Verbs (same command-module spirit as operator/src/cli/commands/, kept
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_IPFS_GATEWAY_URL,
  DEFAULT_TESTNET_DISCOVERY_URL,
  type CorpusRecord,
  type CorpusSearchHit,
  type HarnessLayer,
} from './consume.js';
import { corpusProbes, CORPUS_ONBOARDING_K } from './corpus-probes.js';
import {
  createJinnPlugin,
  type JinnPluginDeps,
} from '@jinn-network/plugin';
import {
  defaultEvidenceIndexPath,
  inspectEvidenceStore,
  reindexEvidenceStore,
} from '@jinn-network/core';
import { buildDefaultLayer } from './layer-default.js';
import { buildPluginDepsFromEnv } from './plugin-wiring.js';
import {
  PROCESS_CONTRACT_VERSION,
  SessionEndRequestV1Schema,
  SessionPickupRequestV1Schema,
  envelope as processEnvelope,
  contributionLedgerRow,
  sessionPickupEnvelope,
  sessionEndEnvelope,
  trackingCorpus,
} from './process-contract.js';
import { capture, parseCapturedTask, type CapturedTask, type ScrubRedaction } from './capture.js';
import { preview, stripBeforeValues, type ScrubReport } from './preview.js';
import { createMemoryLedger, DEFAULT_LEDGER_PATH, ledger, toLedgerRow, type LedgerEntry } from './ledger.js';
import { publish, type HarnessPublishDeps } from './publish.js';
import {
  createGithubSeedSource,
  parseSeedListEntry,
  type SeedSource,
} from './seed-import/fetch.js';
import { plan as seedPlan } from './seed-import/plan.js';
import { execute as seedExecute } from './seed-import/execute.js';
import { parseImportReport, renderImportReport } from './seed-import/report.js';
import { createLocalEpisodeSeedSource, type EpisodeSource } from './seed-import/episode-fetch.js';
import { planEpisodes } from './seed-import/episode-plan.js';
import { executeEpisodes } from './seed-import/episode-execute.js';
import { parseEpisodeImportReport, renderEpisodeImportReport } from './seed-import/episode-report.js';
import { createFileSeedImportState, type SeedImportStateStore } from './seed-import/state.js';
import { extractSkill } from './skill.js';
import { isInsidePackageDir, writePackageTreeSafely } from './path-safety.js';
import { IPFS_RAW_CODEC, parseIpfsCid } from './ipfs-cid.js';
import { runDistillationPipeline } from './pipeline.js';
import { modelLabel, runEvalPrep } from './eval-prep.js';
import { createVerdictSource, type VerdictSource } from './bridge-verdict-source.js';
import {
  createEvidenceFetcher,
  type EvidenceFetcherPorts,
  type ExecutionEnvelopeAuthenticator,
  type PublisherSafeResolver,
  type VerifierFactsResolver,
} from './bridge-fetch-evidence.js';
import {
  createClaudeDistiller,
  createClaudeMetaDistiller,
  createCodexDistiller,
  createCodexMetaDistiller,
  DEFAULT_CODEX_MODEL,
  DEFAULT_MODEL as DEFAULT_CLAUDE_DISTILL_MODEL,
  DISTILLER_CATALOG,
} from './distill-llm.js';
import { createLocalDistiller, createLocalSkillSink } from './distiller.js';
import { parseSkillMarkdown, type SkillPackage } from './skill-package.js';
import {
  DEFAULT_DISTILL_MODE_PATH,
  readDistillDefaults,
  readDistillMode,
  writeDistillDefaults,
  writeDistillMode,
  type DistillMode,
} from './distill-mode.js';
import {
  DEFAULT_CAPTURES_DIR,
  DEFAULT_DISTILL_CAPTURE_LIMIT,
  DEFAULT_EPISODES_DIR,
  DEFAULT_SKILLS_INSTALL_DIR,
  coveredSessionIds,
  loadRecentDistillSources,
  provenanceLabels,
  stagingDirFor,
} from './distill-captures.js';
import {
  renderConsentDisclosure,
  renderPreview,
  renderConfirmLocal,
  renderModeSet,
  renderDistillerSet,
  renderDistillerModels,
  renderDeferredRun,
  renderRecorded,
  renderEmpty,
  renderRunSummary,
  renderSkillsPanel,
  renderReview,
  renderFailure,
  renderResumeNothing,
  type RenderedSkill,
} from './distill-render.js';
import type { AttemptRef, BridgeEvidence } from './bridge.js';
import type { DistillCluster, DistillLLMOutput, MetaDistillLLMOutput } from './distill.js';
import {
  createNdjsonProgressEmitter,
  newRunId,
  type ProgressStream,
} from './distill-progress.js';
import {
  appendDistillRun,
  readDistillRuns,
  DEFAULT_DISTILL_RUNS_PATH,
  type DistillRunRecord,
} from './distill-runs.js';
import type { MetaCluster } from './cluster.js';

const USAGE = `Usage: jinn-layer <command> [args]

Commands:
  reindex [--repair|--dry-run] [--json] [--episodes-dir <dir>] [--index-path <file>]
                                                 Rebuild the machine-local derived evidence index.
                                                 --repair also normalizes the known null quartet
                                                 and rescues misnamed episode files.
                                                 --dry-run only reports readability; it writes nothing.
  contract --json                                 Print process contract version 1
  session pickup                                  Read a v1 pickup request on stdin
  session end                                     Read a complete EpisodeV1 request on stdin
  history --json                                  Derive local session history from canonical stores
  contribution preview [--ack] --json             Show the next sanitized first-share preview;
                                                   --ack records the one-time acknowledgement
  contribution ledger --json                      Show privacy-safe canonical contribution states
  contribution disable --json                     Disable every unpublished authorization
  corpus search "<query>" [--limit N] [--json]   Search corpus records (substring match on
                                                 solverType / role / artifactType / refs)
  corpus get <ref> [--json] [--out <dir>]        Fetch a record by ref (manifest CID from a
                                                 search result), including artifact content
  corpus probe "<slug>" [--json]                 Run the corpus doctor probes for a repo slug
                                                 (corpus-reachable + corpus-content) in one
                                                 round-trip
  skills install <ref> [--out <dir>] [--json]    Install the skill carried by a corpus record
                                                 (jinn.skill.v1 artifact, or the legacy seeded
                                                 trace shape): writes SKILL.md + companion files
                                                 to <dir> (default ./<skill-name slug>)
  capture preview <task-file> [--json] [--full]  Scrub a captured task and show a compact,
                                                 readable summary of what would leave this
                                                 machine (task, tools, grouped redaction
                                                 counts, one line per step). --full also prints
                                                 the per-field before→after audit and the full
                                                 envelope JSON; --json emits the machine report.
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
                                                 signed off). Idempotent: unchanged seeds
                                                 republish nothing; changed seeds supersede
                                                 the prior record
  seed plan --episodes-dir <dir> [--out <report-file>] [--json]
                                                 List + validate evidence-episode seed files
                                                 (docs/runbooks/stage1-evidence-seeding.md);
                                                 ZERO writes
  seed execute <report-file> --episodes-dir <dir> [--json]
                                                 Publish the approved evidence episodes
                                                 (APPROVAL GATE, idempotent + supersedes,
                                                 same as the skill lane above)
  distill run [--limit N] [--out <dir>] [--meta]
              [--distiller claude|codex] [--local-only]
              [--anchor-mode per-record|manifest]
              [--measure-per-record-control]
                                                 Run the distillation pipeline over the
                                                 swe-rebench-v2 verdict ledger: verdict→solution
                                                 join → distill → local SKILL.md packages.
                                                 Held-out slate instances are excluded. Writes
                                                 <out>/<name>/SKILL.md and prints the summary.
                                                 --meta also runs stage-2 cross-instance
                                                 meta-distill over the stage-1 skills.
                                                 --local-only avoids chain writes and evidence
                                                 anchors, using in-memory publish deps.
                                                 --anchor-mode manifest creates one anchor per raw-block-sized partition,
                                                 records receipt gas, and safely resumes its durable journal.
                                                 --measure-per-record-control adds one live
                                                 receipt-bound capture anchor for comparison.
  distill [--where local|defer|off] [--install all|<name>|none] [--resume]
         [--episodes <dir>] [--captures <legacy-dir>] [--limit N] [--out <dir>]
         [--distiller claude|codex] [--distiller-model <model>] [--json]
         [--progress ndjson] [--cluster-timeout <seconds>]
                                                 Rung-1 own-captures loop: distill YOUR recent local
                                                 captures into skills, fully local (no corpus publish,
                                                 no chain anchor). A heavy local pass, so you control
                                                 WHERE it runs (#1490):
                                                   --where local  distill here now (a spend; confirms)
                                                   --where defer  hold captures, run nothing (default)
                                                   --where off    stop reserving captures
                                                 --where sets the persistent mode and echoes it —
                                                 nothing runs. A bare 'distill' with no recorded mode
                                                 shows first-run consent (interactive) or takes the
                                                 safe default (defer) non-interactively.
                                                 A LOCAL run distills to a STAGING area and installs
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
                                                 --resume distills only the captures no distilled skill
                                                 (installed OR staged) already covers.
                                                 --json reports the distilled and installed sets
                                                 separately.
                                                 --distiller-model is the arbitrage knob: it is the
                                                 model that WRITES the skills, distinct from the
                                                 cheap runtime model your captures ran under.
                                                 --progress ndjson streams machine-readable run
                                                 events (run_start/cluster_*/heartbeat/run_end,
                                                 one JSON object per line, stamped v/ts/runId) on
                                                 stderr for wrappers; run_end is always emitted.
                                                 Non-interactive use only — stdout --json is
                                                 unaffected; ignore stderr lines without a v field.
                                                 --cluster-timeout caps each cluster's distiller
                                                 subprocess (seconds; default 600). On expiry the
                                                 child is killed, that cluster lands in errors,
                                                 and the run continues.
  distill status [--episodes <dir>] [--captures <legacy-dir>] [--out <dir>] [--json]
                                                 The loop's state in one read: mode, reserved
                                                 captures (total + not yet distilled), staged and
                                                 installed counts, resolved distiller, last run.
                                                 Pure reads — never prompts, spends, or writes.
  distill runs [--limit N] [--json]              Recorded runs, newest-first (one record per run
                                                 outcome: ok / partial / empty).
  distill staged [--out <dir>] [--json]          Skills waiting in the staging area (<out>-staged):
                                                 name, what each helps with, provenance. Read-only.
  distill install [<name> ...] [--all] [--out <dir>] [--json]
                                                 Install previously STAGED skills into the active
                                                 dir — no distillation, no consent gate, no LLM
                                                 calls; these are artifacts an earlier LOCAL run
                                                 already produced. Installed staged copies are
                                                 removed (staging holds only what's not installed).
  distill eval-prep [--limit N] [--out <dir>] [--json] [--meta] [--select-only]
                    [--group-cap N] [--concurrency N] [--force] [--retry-errors]
                    [--models gpt-5.4-mini,gpt-5.5]
                    [--max-clusters N] [--max-contrastive N]
                    [--max-lessons N] [--max-patterns N]
                                                 Bridge/gate/cluster once, freeze a useful
                                                 cluster set, then run each Codex model over
                                                 exactly those clusters. Always local-only.
                                                 --meta runs per-model cross-instance
                                                 meta-distill over each model's accepted
                                                 stage-1 skills.
                                                 --select-only writes selection/raw evidence
                                                 artifacts and skips all model calls.
                                                 Existing --out dirs resume by default;
                                                 --force rebuilds from scratch, and
                                                 --retry-errors reruns error records.

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
  JINN_DB_PATH                  SQLite anchor telemetry store (manifest mode)

Environment (distill — reads the testnet ledger + spends model solves):
  JINN_DISCOVERY_URL       Ponder indexer base (default: testnet jinn-indexer)
  JINN_IPFS_GATEWAY_URL    IPFS gateway for envelope fetches (default: https://gateway.autonolas.tech)
  JINN_DISTILL_PROVIDER    Distiller provider: claude or codex (default: claude)
  JINN_DISTILL_MODEL       Distiller model (defaults: claude-opus-4-8 for claude, gpt-5.5 for codex)
  (publish env above)      distill also captures + anchors the bridged evidence on testnet unless --local-only

Environment (distill — the rung-1 local episode loop; runs fully locally):
  JINN_LAYER_EPISODES_DIR    Canonical EpisodeV1 dir (default: ~/.jinn-client/harness-layer/episodes)
  JINN_LAYER_CAPTURES_DIR    Deprecated legacy CapturedTask read dir (default: ~/.jinn-client/harness-layer/captures)
  JINN_LAYER_DISTILL_MODE_PATH  Where-it-runs mode file (default: ~/.jinn-client/harness-layer/distill.json)
  JINN_LAYER_DISTILL_RUNS_PATH  Run log (default: ~/.jinn-client/harness-layer/distill-runs.jsonl)
  JINN_DISTILL_PROVIDER      Distiller provider: claude or codex (default: claude)
  JINN_DISTILL_MODEL         Distiller model (overridden by --distiller-model)
`;

export type DistillProvider = 'claude' | 'codex';

export interface DistillPorts {
  distill: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  metaDistill: (cluster: MetaCluster) => Promise<MetaDistillLLMOutput>;
}

/** Injectable deps for `distill run` (tests). Production defaults build the live wiring. */
export interface DistillRunCliDeps {
  /** Ledger verdict-row source (both polarities). Default: live indexer. */
  verdictSource?: VerdictSource;
  /** Fetch the patch + problem statement for an attempt. Default: live gateway + indexer. */
  fetchEvidence?: (ref: AttemptRef) => Promise<BridgeEvidence>;
  /**
   * Production composition hook for authenticated SWE verifier facts. Receives
   * the CLI's bounded IPFS reader so solver-specific proof resolution cannot
   * introduce an unbounded duplicate gateway path.
   */
  verifierFactsResolverFactory?: (
    ipfs: EvidenceFetcherPorts['ipfs'],
  ) => VerifierFactsResolver;
  /** Production composition hook for raw execution-envelope authentication. */
  authenticateEnvelope?: ExecutionEnvelopeAuthenticator;
  /** Production composition hook for ERC-8004 publisher → Safe resolution. */
  resolvePublisherSafe?: PublisherSafeResolver;
  /** The LLM distill port. Default: createClaudeDistiller. */
  distill?: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  /** The stage-2 meta LLM port. Default: createClaudeMetaDistiller. */
  metaDistill?: (cluster: MetaCluster) => Promise<MetaDistillLLMOutput>;
  /** Provider-aware port factory (tests/embedders). Default: Claude or Codex CLI ports. */
  distillerFactory?: (provider: DistillProvider, model: string, timeoutMs?: number) => DistillPorts;
  /** Layer-1 evidence publish deps. Default: live testnet wiring from env. */
  publishDeps?: HarnessPublishDeps;
  /** Held-out slate instance ids. Default: the active swe-rebench-v2 slate. */
  slateInstanceIds?: Set<string>;
}

/**
 * Injectable deps for the rung-1 `distill` own-captures loop (tests). Production
 * defaults resolve the distill port from the provider + distiller model.
 */
export interface DistillCliDeps {
  /** The LLM distill port. Default: provider factory over the resolved distiller model. */
  distill?: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  /** Provider-aware port factory (tests). Default: Claude or Codex CLI ports. */
  distillerFactory?: (provider: DistillProvider, model: string, timeoutMs?: number) => DistillPorts;
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
  promptConsent?: () => Promise<DistillMode>;
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
  /**
   * Where `--progress ndjson` events are written (#1533). Default:
   * `process.stderr` — stdout stays reserved for the `--json` result.
   */
  progressStream?: ProgressStream;
}

/** The install-review choice: everything, just the first, or none (stage only). */
export type InstallChoice = 'all' | 'first' | 'none';

export interface JinnLayerWriter {
  write(value: string): boolean;
}

export interface RunJinnLayerCliOptions {
  /** Injectable layer (tests). Default: createHarnessLayer() with env overrides. */
  layer?: HarnessLayer;
  /** Injectable publish deps (tests). Default: live testnet wiring from env. */
  publishDeps?: HarnessPublishDeps;
  /** Injectable seed source (tests). Default: GitHub source over --source list. */
  seedSource?: SeedSource;
  /** Injectable evidence-episode seed source (tests). Default: local dir source over --episodes-dir. */
  episodeSource?: EpisodeSource;
  /** Injectable seed-import idempotency state (tests). Default: file-backed store (real `seed execute` runs). */
  seedImportState?: SeedImportStateStore;
  /** Injectable distill-pipeline deps (tests). Default: live wiring per field. */
  distillRunDeps?: DistillRunCliDeps;
  /** Injectable rung-1 own-captures deps (tests). Default: provider-resolved distill port. */
  distillDeps?: DistillCliDeps;
  /** Injectable stdin reader for versioned process commands. */
  reader?: () => Promise<string>;
  /** Real ports are used by default; tests can override any subset. */
  pluginOverrides?: Partial<JinnPluginDeps>;
  writer?: JinnLayerWriter;
}

const DEFAULT_CLI_SEARCH_LIMIT = 20;

/**
 * Byte ceiling on any single IPFS object fetched by the distill pipeline
 * (PR #1476 security review): envelopes are KBs; donation-wrapped
 * system_snapshots observed live are ≤ ~400 KB. 64 MiB leaves generous
 * headroom while preventing a malicious multi-GB wrapper from OOMing the run.
 */
const MAX_IPFS_FETCH_BYTES = 64 * 1024 * 1024;

export interface BoundedIpfsJsonFetcherOptions {
  gateway: string;
  /** Default ceiling for ordinary evidence hops. Defaults to 64 MiB. */
  defaultMaxBytes?: number;
  /** One deadline covers response headers and streaming body reads. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Build the live IPFS JSON port with a caller-selectable finite byte ceiling.
 *
 * The stream is cancelled on the first over-limit chunk, so hostile evidence
 * is never fully buffered before the cap is enforced. The verifier resolver
 * uses the second argument for its tighter authenticated-artifact ceiling.
 */
export function createBoundedIpfsJsonFetcher(
  options: BoundedIpfsJsonFetcherOptions,
): EvidenceFetcherPorts['ipfs'] {
  const gateway = options.gateway.replace(/\/$/, '');
  const defaultMaxBytes = options.defaultMaxBytes ?? MAX_IPFS_FETCH_BYTES;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  if (!Number.isSafeInteger(defaultMaxBytes) || defaultMaxBytes <= 0) {
    throw new Error('IPFS default fetch ceiling must be a positive safe integer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('IPFS fetch timeout must be a positive safe integer');
  }

  return async (cid: string, maxBytes = defaultMaxBytes): Promise<unknown> => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('IPFS fetch ceiling must be a positive safe integer');
    }
    // Bound length before the structural decoder: CIDv0 base58 decoding is
    // intentionally dependency-free but superlinear for enormous strings.
    const parsedCid = cid.length <= 256 ? parseIpfsCid(cid) : null;
    if (!parsedCid) {
      throw new Error(`ipfs ${JSON.stringify(cid)}: expected a valid IPFS CID`);
    }
    const requestUrl = new URL(`${gateway}/ipfs/${encodeURIComponent(cid)}`).href;
    const response = await fetchImpl(requestUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (
      response.redirected
      || (response.url !== '' && response.url !== requestUrl)
    ) {
      throw new Error(`ipfs ${cid}: gateway redirects are not allowed`);
    }
    if (!response.ok) throw new Error(`ipfs ${cid}: HTTP ${response.status}`);

    const rawLength = response.headers.get('content-length');
    if (rawLength !== null) {
      const declaredLength = Number(rawLength);
      if (
        Number.isSafeInteger(declaredLength)
        && declaredLength >= 0
        && declaredLength > maxBytes
      ) {
        throw new Error(
          `ipfs ${cid}: ${declaredLength} bytes exceeds the ${maxBytes}-byte fetch ceiling`,
        );
      }
    }
    if (!response.body) {
      throw new Error(`ipfs ${cid}: response has no body`);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > maxBytes) {
          try {
            await reader.cancel('IPFS response exceeded fetch ceiling');
          } catch {
            // Preserve the deterministic ceiling error if cancellation races.
          }
          throw new Error(
            `ipfs ${cid}: ${length} bytes exceeds the ${maxBytes}-byte fetch ceiling`,
          );
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (parsedCid.codec === IPFS_RAW_CODEC) {
      const actualDigest = createHash('sha256').update(bytes).digest();
      if (!actualDigest.equals(Buffer.from(parsedCid.sha256Digest))) {
        throw new Error(
          `ipfs ${cid}: fetched content digest does not match requested CID`,
        );
      }
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(
        `ipfs ${cid}: invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(
        `ipfs ${cid}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

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

/** Warn-once latch for the legacy single-l env name (issue #1532). */
let warnedLegacyModePathEnv = false;

/** Where the persisted `distill` mode lives; env-overridable for tests / CI. */
function distillModePath(): string {
  const current = process.env['JINN_LAYER_DISTILL_MODE_PATH'];
  if (current !== undefined) return current;
  const legacy = process.env['JINN_LAYER_DISTIL_MODE_PATH'];
  if (legacy !== undefined) {
    if (!warnedLegacyModePathEnv) {
      warnedLegacyModePathEnv = true;
      console.warn(
        '[distill] JINN_LAYER_DISTIL_MODE_PATH is renamed to JINN_LAYER_DISTILL_MODE_PATH (double l); the old name still works but will be dropped',
      );
    }
    return legacy;
  }
  return DEFAULT_DISTILL_MODE_PATH;
}

/** Count the skill directories (subdirectories carrying a SKILL.md) under dir. */
function countSkillDirs(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md'))) count += 1;
  }
  return count;
}

/**
 * Parse every staged skill under `stagingDir` (#1536). An unparseable
 * SKILL.md is skipped with a stderr warning — one bad artifact must not
 * hide the rest of the staging area.
 */
function listStaged(stagingDir: string): SkillPackage[] {
  if (!existsSync(stagingDir)) return [];
  const pkgs: SkillPackage[] = [];
  for (const entry of readdirSync(stagingDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const md = join(stagingDir, entry.name, 'SKILL.md');
    if (!existsSync(md)) continue;
    try {
      pkgs.push(parseSkillMarkdown(readFileSync(md, 'utf-8')));
    } catch (err) {
      console.warn(`[distill] skipping unparseable staged skill ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return pkgs;
}

/**
 * Install skills into the active dir and remove their staged copies — the
 * single install path (#1536), shared by the inline run flow and the
 * `distill install` subverb, so staging always holds exactly what is not
 * installed. NO LLM calls, NO consent gate: these are artifacts an earlier
 * consented LOCAL run already produced.
 */
async function installStagedSkills(
  pkgs: SkillPackage[],
  stagingDir: string,
  activeDir: string,
): Promise<Array<{ name: string; path: string }>> {
  const sink = createLocalSkillSink(activeDir);
  const installed: Array<{ name: string; path: string }> = [];
  for (const pkg of pkgs) {
    await sink(pkg);
    rmSync(join(stagingDir, pkg.name), { recursive: true, force: true });
    installed.push({ name: pkg.name, path: join(activeDir, pkg.name, 'SKILL.md') });
  }
  return installed;
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
}): Promise<DistillMode> {
  o.writer.write(renderConsentDisclosure({ captureCount: o.captureCount, distillModel: o.distillModel }) + '\n');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    for (;;) {
      const a = (await ask(rl, '\ndistill where? [L]ocal now · [F] defer (default) · [O]ff · [P]review: ')).trim().toLowerCase();
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

/** Collect items into a Map keyed by `key`, preserving first-seen key order. */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const group = out.get(key(item)) ?? [];
    group.push(item);
    out.set(key(item), group);
  }
  return out;
}

/**
 * Group redaction entries by field: the pipeline reports one entry per
 * detection, so a busy attribute produces many entries with identical
 * before/after — one block per field with the union of firing stages is the
 * readable audit view.
 */
function renderRedactionsByField(redactions: ScrubRedaction[]): string[] {
  const byField = groupBy(redactions, (r) => r.field);
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

function renderScrubReport(report: ScrubReport, full: boolean): string {
  const env = report.envelope;
  const truncated = env.trajectory.reduce((n, s) => n + (s.truncatedKeys?.length ?? 0), 0);
  const distinctFields = new Set(report.redactions.map((r) => r.field)).size;

  const lines = [
    'scrub preview — what would leave this machine',
    `  task     ${env.task.summary}`,
    `  tags     ${env.task.distributionTags.join(', ')}`,
    `  harness  ${env.environment.harness.name}@${env.environment.harness.version}`,
    `  model    ${env.environment.model}`,
    `  outcome  ${env.outcome.status} / strength ${env.outcome.verificationStrength}`,
    `  steps    ${env.trajectory.length}`,
    `  tools    ${env.environment.tools.length > 0 ? env.environment.tools.join(', ') : '(none)'}`,
    '',
  ];

  // Redactions grouped by stage → detail, with counts — the safety core.
  if (report.redactions.length === 0) {
    lines.push('no redactions — the scrub pipeline found nothing to remove');
  } else {
    lines.push(
      `redactions   ${report.redactions.length} across ${distinctFields} field(s), ${truncated} truncation(s)`,
    );
    for (const [stage, group] of groupBy(report.redactions, (r) => r.stage)) {
      lines.push(`  ${stage}  ${group.length}`);
      const byDetail = new Map<string, number>();
      for (const r of group) {
        const key = r.detail ?? '(no detail)';
        byDetail.set(key, (byDetail.get(key) ?? 0) + 1);
      }
      for (const [detail, count] of byDetail) {
        lines.push(`    ${detail} ×${count}`);
      }
    }
  }

  // One short line per step — no attributes dump.
  lines.push('', 'steps:');
  env.trajectory.forEach((s, i) => {
    const parts = [`${s.redactedKeys.length} redacted`];
    const tk = s.truncatedKeys?.length ?? 0;
    if (tk > 0) parts.push(`${tk} truncated`);
    lines.push(`  [${i}] ${s.name}  ${parts.join(', ')}`);
  });

  if (full) {
    if (report.redactions.length > 0) {
      lines.push(
        '',
        `${report.redactions.length} redaction(s) — "before" is shown here only and never leaves this machine`,
        '',
        ...renderRedactionsByField(report.redactions),
      );
    }
    lines.push('', 'envelope as it would publish:', JSON.stringify(env, null, 2));
  }

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

function defaultDistillerFactory(provider: DistillProvider, model: string, timeoutMs?: number): DistillPorts {
  const timeout = timeoutMs !== undefined ? { timeoutMs } : {};
  if (provider === 'codex') {
    return {
      distill: createCodexDistiller({ model, ...timeout }),
      metaDistill: createCodexMetaDistiller({ model, ...timeout }),
    };
  }
  return {
    distill: createClaudeDistiller({ model, ...timeout }),
    metaDistill: createClaudeMetaDistiller({ model, ...timeout }),
  };
}

/**
 * Resolve the per-cluster distiller deadline (#1534): `--cluster-timeout`
 * (seconds) > `JINN_DISTILL_CLUSTER_TIMEOUT_S` > undefined (the port default).
 * Returns milliseconds, or an error message for a bad value.
 */
function resolveClusterTimeoutMs(flagValue: string | undefined): number | undefined | { error: string } {
  const raw = flagValue ?? process.env['JINN_DISTILL_CLUSTER_TIMEOUT_S'];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0) {
    return { error: `error: --cluster-timeout must be a positive integer number of seconds (got ${JSON.stringify(raw)})` };
  }
  return seconds * 1000;
}

async function readStdinToEnd(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function interfaceError(writer: { write: (s: string) => boolean }, error: unknown): number {
  writer.write(`error: invalid process request: ${error instanceof Error ? error.message : String(error)}\n`);
  return 2;
}

/** Returns the process exit code (0 = success). */
export async function runJinnLayerCli(
  argv: string[],
  opts: RunJinnLayerCliOptions = {},
): Promise<number> {
  const writer = opts.writer ?? process.stdout;
  const reader = opts.reader ?? readStdinToEnd;
  const [verb, subverb, ...rest] = argv;

  const isCorpus = verb === 'corpus' && (subverb === 'search' || subverb === 'get' || subverb === 'probe');
  const isCapturePreview = verb === 'capture' && subverb === 'preview';
  const isLedger = verb === 'ledger';
  const isPublish = verb === 'publish';
  const isSeed = verb === 'seed' && (subverb === 'plan' || subverb === 'execute');
  const isSkillsInstall = verb === 'skills' && subverb === 'install';
  const isDistillRun = verb === 'distill' && subverb === 'run';
  const isDistillEvalPrep = verb === 'distill' && subverb === 'eval-prep';
  const isDistillModels = verb === 'distill' && subverb === 'models';
  const isDistill = verb === 'distill' && !isDistillRun && !isDistillEvalPrep && !isDistillModels;
  const isDeriveEnv = verb === 'derive-env';
  const isContract = verb === 'contract';
  const isSessionPickup = verb === 'session' && subverb === 'pickup';
  const isSessionEnd = verb === 'session' && subverb === 'end';
  const isHistory = verb === 'history';
  const isContributionPreview = verb === 'contribution' && subverb === 'preview';
  const isContributionLedger = verb === 'contribution' && subverb === 'ledger';
  const isContributionDisable = verb === 'contribution' && subverb === 'disable';
  const isReindex = verb === 'reindex';
  if (!isCorpus && !isCapturePreview && !isLedger && !isPublish && !isSeed && !isSkillsInstall && !isDistillRun && !isDistillEvalPrep && !isDistillModels && !isDistill && !isDeriveEnv && !isContract && !isSessionPickup && !isSessionEnd && !isHistory && !isContributionPreview && !isContributionLedger && !isContributionDisable && !isReindex) {
    writer.write(USAGE);
    return verb === undefined || verb === 'help' || verb === '--help' ? 0 : 2;
  }

  if (isReindex) {
    const reindexArgs = subverb === undefined ? rest : [subverb, ...rest];
    const requestedJson = reindexArgs.includes('--json');
    let parsed;
    try {
      parsed = parseArgs({
        args: reindexArgs,
        options: {
          repair: { type: 'boolean', default: false },
          'dry-run': { type: 'boolean', default: false },
          json: { type: 'boolean', default: false },
          'episodes-dir': { type: 'string' },
          'index-path': { type: 'string' },
        },
        strict: true,
        allowPositionals: false,
      });
    } catch (error) {
      const message = `invalid reindex command: ${
        error instanceof Error ? error.message : String(error)
      }`;
      writer.write(requestedJson
        ? `${JSON.stringify({
          status: 'error',
          mode: 'reindex',
          repair: reindexArgs.includes('--repair'),
          error: message,
        })}\n`
        : `error: ${message}\n\n${USAGE}`);
      return 2;
    }
    if (parsed.values.repair && parsed.values['dry-run']) {
      const episodesDir = parsed.values['episodes-dir']
        ?? process.env['JINN_LAYER_EPISODES_DIR']
        ?? DEFAULT_EPISODES_DIR;
      const indexPath = parsed.values['index-path']
        ?? process.env['JINN_LAYER_EVIDENCE_INDEX_PATH']
        ?? defaultEvidenceIndexPath(episodesDir);
      const message = 'invalid reindex command: --repair and --dry-run are mutually exclusive';
      writer.write(parsed.values.json
        ? `${JSON.stringify({
          status: 'error',
          mode: 'reindex',
          episodesDir,
          indexPath,
          repair: true,
          error: message,
        })}\n`
        : `error: ${message}\n\n${USAGE}`);
      return 2;
    }
    const episodesDir = parsed.values['episodes-dir']
      ?? process.env['JINN_LAYER_EPISODES_DIR']
      ?? DEFAULT_EPISODES_DIR;
    const configuredIndexPath = parsed.values['index-path']
      ?? process.env['JINN_LAYER_EVIDENCE_INDEX_PATH']
      ?? defaultEvidenceIndexPath(episodesDir);
    const dryRun = parsed.values['dry-run'];
    const indexPath = dryRun ? null : configuredIndexPath;
    try {
      const report = dryRun
        ? inspectEvidenceStore({ episodesDir })
        : reindexEvidenceStore({
          episodesDir,
          indexPath: configuredIndexPath,
          repair: parsed.values.repair,
        });
      const publicationFailed = !dryRun && !report.indexUpdated;
      const status = report.unreadableFiles > 0 || publicationFailed ? 'degraded' : 'ok';
      if (parsed.values.json) {
        writer.write(`${JSON.stringify({
          status,
          mode: dryRun ? 'inspect' : 'reindex',
          episodesDir,
          indexPath,
          repair: parsed.values.repair,
          report,
        })}\n`);
      } else {
        writer.write([
          `Evidence ${dryRun ? 'inspection' : 'reindex'} ${status}: ${report.indexedEpisodes}/${report.scannedFiles} files indexed`,
          `Index: ${indexPath === null
            ? 'not rebuilt (--dry-run)'
            : report.indexUpdated
              ? indexPath
              : `not updated (${report.indexError ?? 'unknown publication failure'})`}`,
          `Repairs: ${report.nullFieldsRemoved} null fields removed; ${report.renamedFiles} files renamed`,
          `Legacy unstamped: ${report.legacyUnstampedFiles}`,
          `Synthetic fixtures excluded: ${report.syntheticExcludedFiles}`,
          ...report.syntheticExcluded.map((row) => `  ${row.path}: ${row.reason}`),
          `Unreadable: ${report.unreadableFiles}`,
          ...report.unreadable.map((row) => `  ${row.path}: ${row.reason}`),
          '',
        ].join('\n'));
      }
      return report.unreadableFiles > 0 || publicationFailed ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (parsed.values.json) {
        writer.write(`${JSON.stringify({
          status: 'error',
          mode: dryRun ? 'inspect' : 'reindex',
          episodesDir,
          indexPath,
          repair: parsed.values.repair,
          error: message,
        })}\n`);
      } else {
        writer.write(`error: evidence reindex failed: ${message}\n`);
      }
      return 1;
    }
  }

  if (isContract) {
    if (!((subverb === undefined && rest.length === 0) || (subverb === '--json' && rest.length === 0))) {
      writer.write('error: invalid contract command; use jinn-layer contract --json\n');
      return 2;
    }
    writer.write(`${JSON.stringify({
      contractVersion: PROCESS_CONTRACT_VERSION,
    })}\n`);
    return 0;
  }

  if (isSessionPickup || isSessionEnd) {
    if (rest.length > 0) {
      writer.write(`error: invalid ${isSessionPickup ? 'session pickup' : 'session end'} command; request JSON belongs on stdin\n`);
      return 2;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await reader());
    } catch (error) {
      return interfaceError(writer, error);
    }
    try {
      const deps = buildPluginDepsFromEnv(opts.pluginOverrides ?? {});
      if (isSessionPickup) {
        const request = SessionPickupRequestV1Schema.parse(raw);
        const tracked = trackingCorpus(deps);
        const result = await createJinnPlugin(tracked.deps)
          .session(request.meta)
          .firstTurnPickup(request.firstMessage, {
            excludeCanonicalEpisodeIds: request.excludeCanonicalEpisodeIds,
          });
        writer.write(`${JSON.stringify(sessionPickupEnvelope(
          result,
          tracked.status(),
          tracked.reason(),
        ))}\n`);
      } else {
        const request = SessionEndRequestV1Schema.parse(raw);
        const result = await createJinnPlugin(deps).completeSession(request);
        writer.write(`${JSON.stringify(sessionEndEnvelope(result))}\n`);
      }
      return 0;
    } catch (error) {
      return interfaceError(writer, error);
    }
  }

  if (isHistory) {
    if (subverb !== '--json' || rest.length !== 0) {
      writer.write('error: invalid history command; use jinn-layer history --json\n');
      return 2;
    }
    const result = await createJinnPlugin(buildPluginDepsFromEnv(opts.pluginOverrides ?? {}))
      .history();
    const status = result.unavailable ? 'unavailable' : result.degraded ? 'degraded' : 'ok';
    writer.write(`${JSON.stringify(processEnvelope(
      status,
      { entries: result.entries },
      result.reason,
    ))}\n`);
    return 0;
  }

  if (isContributionPreview) {
    const flags = new Set(rest);
    if ([...flags].some((arg) => arg !== '--ack' && arg !== '--json') || flags.size !== rest.length) {
      writer.write('error: invalid contribution preview command\n');
      return 2;
    }
    const result = await createJinnPlugin(buildPluginDepsFromEnv(opts.pluginOverrides ?? {}))
      .previewContribution(flags.has('--ack'));
    if (result.status === 'ok') {
      writer.write(`${JSON.stringify(processEnvelope('ok', result.value))}\n`);
    } else if (result.status === 'degraded') {
      writer.write(`${JSON.stringify(processEnvelope('degraded', result.value, result.reason))}\n`);
    } else {
      writer.write(`${JSON.stringify(processEnvelope('unavailable', undefined, result.reason))}\n`);
    }
    return 0;
  }

  if (isContributionLedger) {
    if (rest.length !== 1 || rest[0] !== '--json') {
      writer.write('error: invalid contribution ledger command; use contribution ledger --json\n');
      return 2;
    }
    const result = await createJinnPlugin(buildPluginDepsFromEnv(opts.pluginOverrides ?? {}))
      .contributionLedger();
    if (result.status === 'ok') {
      writer.write(`${JSON.stringify(processEnvelope('ok', {
        rows: result.value.map(contributionLedgerRow),
      }))}\n`);
    } else if (result.status === 'degraded') {
      writer.write(`${JSON.stringify(processEnvelope('degraded', {
        rows: (result.value ?? []).map(contributionLedgerRow),
      }, result.reason))}\n`);
    } else {
      writer.write(`${JSON.stringify(processEnvelope('unavailable', undefined, result.reason))}\n`);
    }
    return 0;
  }

  if (isContributionDisable) {
    if (rest.some((arg) => arg !== '--json') || rest.length > 1) {
      writer.write('error: invalid contribution disable command\n');
      return 2;
    }
    const result = await createJinnPlugin(buildPluginDepsFromEnv(opts.pluginOverrides ?? {}))
      .disableContributionPublication();
    if (result.status === 'ok') {
      writer.write(`${JSON.stringify(processEnvelope('ok', result.value))}\n`);
    } else if (result.status === 'degraded') {
      writer.write(`${JSON.stringify(processEnvelope('degraded', result.value, result.reason))}\n`);
    } else {
      writer.write(`${JSON.stringify(processEnvelope('unavailable', undefined, result.reason))}\n`);
    }
    return 0;
  }

  // `ledger`, `publish`, `distill`, and `derive-env` have no subverb — their args start at argv[1].
  const flat = isLedger || isPublish || isDistill || isDeriveEnv;
  let parsed;
  try {
    parsed = parseArgs({
      args: flat ? (subverb === undefined ? rest : [subverb, ...rest]) : rest,
      options: {
        limit: { type: 'string', default: String(DEFAULT_CLI_SEARCH_LIMIT) },
        json: { type: 'boolean', default: false },
        full: { type: 'boolean', default: false },
        out: { type: 'string' },
        path: { type: 'string' },
        veto: { type: 'boolean', default: false },
        source: { type: 'string' },
        'episodes-dir': { type: 'string' },
        meta: { type: 'boolean', default: false },
        distiller: { type: 'string' },
        'distiller-model': { type: 'string' },
        'set-distiller': { type: 'string' },
        'set-distiller-model': { type: 'string' },
        episodes: { type: 'string' },
        captures: { type: 'string' },
        'local-only': { type: 'boolean', default: false },
        'anchor-mode': { type: 'string', default: 'per-record' },
        'measure-per-record-control': { type: 'boolean', default: false },
        where: { type: 'string' },
        resume: { type: 'boolean', default: false },
        install: { type: 'string' },
        progress: { type: 'string' },
        'cluster-timeout': { type: 'string' },
        all: { type: 'boolean', default: false },
        models: { type: 'string' },
        'max-clusters': { type: 'string' },
        'max-contrastive': { type: 'string' },
        'max-lessons': { type: 'string' },
        'max-patterns': { type: 'string' },
        'group-cap': { type: 'string' },
        concurrency: { type: 'string' },
        'select-only': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        'retry-errors': { type: 'boolean', default: false },
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
      writer.write(renderScrubReport(report, Boolean(parsed.values.full)) + '\n');
    }
    return 0;
  }

  if (isSeed) {
    const listFile = parsed.values.source as string | undefined;
    const episodesDir = parsed.values['episodes-dir'] as string | undefined;
    if (listFile !== undefined && episodesDir !== undefined) {
      writer.write(`error: seed commands require exactly one of --source or --episodes-dir\n\n${USAGE}`);
      return 2;
    }

    const buildSource = (): SeedSource => {
      if (opts.seedSource) return opts.seedSource;
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

    // Evidence-episode source (issue #1771): a separate, parallel lane over
    // --episodes-dir, chosen instead of --source when either is present. The
    // two lanes never mix in one report — episodes are first-party content
    // with no licence gate, so their report shape differs from ImportReport.
    const isEpisodes = Boolean(opts.episodeSource) || episodesDir !== undefined;
    const buildEpisodeSource = (): EpisodeSource => {
      if (opts.episodeSource) return opts.episodeSource;
      if (!episodesDir) {
        throw new Error('seed commands require --episodes-dir <dir> (seed-episode JSON files) or an injected episodeSource');
      }
      return createLocalEpisodeSeedSource(episodesDir);
    };

    if (subverb === 'plan') {
      if (isEpisodes) {
        const episodeReport = await planEpisodes(buildEpisodeSource());
        const outFile = parsed.values.out as string | undefined;
        if (outFile) writeFileSync(outFile, JSON.stringify(episodeReport, null, 2) + '\n');
        if (parsed.values.json) {
          writer.write(JSON.stringify(episodeReport) + '\n');
        } else {
          writer.write(renderEpisodeImportReport(episodeReport) + '\n');
          writer.write(outFile
            ? `\nReport written to ${outFile}. APPROVAL GATE: review (edit verdicts if needed), then run seed execute ${outFile} --episodes-dir ${episodesDir ?? '<dir>'}.\n`
            : '\nAPPROVAL GATE: re-run with --out <report-file>, review, then seed execute.\n');
        }
        return 0;
      }
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
    if (!opts.publishDeps) {
      writer.write(
        'error: seed execute requires an injected client publish adapter; '
          + 'the standalone layer keeps outbound publication parked\n',
      );
      return 2;
    }
    const deps = opts.publishDeps;
    // File-backed by default (issue #1771): real `seed execute` runs persist
    // idempotency state across invocations (path overridable via
    // JINN_LAYER_SEED_STATE_PATH, mirroring JINN_LAYER_LEDGER_PATH). Tests
    // inject an in-memory store. A corrupt state file fails closed (semantics
    // in state.ts); its diagnostic is collected here and surfaced on THIS
    // command's own output in addition to the per-row error.
    const stateWarnings: string[] = [];
    const state = opts.seedImportState ?? createFileSeedImportState(
      process.env['JINN_LAYER_SEED_STATE_PATH'],
      { onWarning: (message) => stateWarnings.push(message) },
    );

    if (isEpisodes) {
      const episodeReport = parseEpisodeImportReport(JSON.parse(readFileSync(reportFile, 'utf-8')));
      const result = await executeEpisodes(episodeReport, buildEpisodeSource(), deps, { state });
      if (parsed.values.json) {
        writer.write(JSON.stringify({
          ...result,
          ...(stateWarnings.length > 0 ? { warnings: stateWarnings } : {}),
        }) + '\n');
      } else {
        const lines = [
          `${result.imported.length} imported, ${result.skipped.length} skipped, ${result.errors.length} error(s)`,
          ...stateWarnings.map((w) => `  WARNING  ${w}`),
        ];
        for (const row of result.imported) {
          lines.push(
            `  IMPORTED ${row.id}`,
            `    ref     ${row.envelopeRef}`,
            `    anchor  ${row.anchorTx ? `${TESTNET_EXPLORER_TX_URL}${row.anchorTx}` : '-'}`,
            ...(row.supersedes ? [`    supersedes ${row.supersedes}`] : []),
            ...(row.ledgerWarning ? [`    WARNING ${row.ledgerWarning}`] : []),
            ...(row.stateWarning ? [`    WARNING ${row.stateWarning}`] : []),
          );
        }
        for (const row of result.skipped) lines.push(`  skipped  ${row.id} — ${row.reason}`);
        for (const row of result.errors) lines.push(`  ERROR    ${row.id} — ${row.error}`);
        writer.write(lines.join('\n') + '\n');
      }
      return result.errors.length > 0 ||
        result.imported.some((row) => row.stateWarning !== undefined || row.ledgerWarning !== undefined)
        ? 1
        : 0;
    }

    const report = parseImportReport(JSON.parse(readFileSync(reportFile, 'utf-8')));
    const result = await seedExecute(report, buildSource(), deps, { state });
    if (parsed.values.json) {
      writer.write(JSON.stringify({
        ...result,
        ...(stateWarnings.length > 0 ? { warnings: stateWarnings } : {}),
      }) + '\n');
    } else {
      const lines = [
        `${result.imported.length} imported, ${result.skipped.length} skipped, ${result.errors.length} error(s)`,
        ...stateWarnings.map((w) => `  WARNING  ${w}`),
      ];
      for (const row of result.imported) {
        lines.push(
          `  IMPORTED ${row.skill}`,
          `    ref     ${row.envelopeRef}`,
          `    anchor  ${row.anchorTx ? `${TESTNET_EXPLORER_TX_URL}${row.anchorTx}` : '-'}`,
          ...(row.ledgerWarning ? [`    WARNING ${row.ledgerWarning}`] : []),
          ...(row.stateWarning ? [`    WARNING ${row.stateWarning}`] : []),
        );
      }
      for (const row of result.skipped) lines.push(`  skipped  ${row.skill} — ${row.reason}`);
      for (const row of result.errors) lines.push(`  ERROR    ${row.skill} — ${row.error}`);
      writer.write(lines.join('\n') + '\n');
    }
    return result.errors.length > 0 ||
      result.imported.some((row) => row.stateWarning !== undefined || row.ledgerWarning !== undefined)
      ? 1
      : 0;
  }

  if (isDistillModels) {
    const json = parsed.values.json as boolean;
    const persisted = readDistillDefaults(distillModePath());
    // Resolve exactly as a run would (minus per-run model-vs-provider nuance):
    // flag > env > persisted > provider default, so the marked row is what a
    // bare `distill` would actually use.
    const rawProvider =
      (parsed.values.distiller as string | undefined) ??
      process.env['JINN_DISTILL_PROVIDER'] ??
      persisted.distiller ??
      'claude';
    const provider = parseDistillProvider(rawProvider) ?? 'claude';
    const defaultModel = provider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_DISTILL_MODEL;
    const model =
      (parsed.values['distiller-model'] as string | undefined) ??
      process.env['JINN_DISTILL_MODEL'] ??
      persisted.distillerModel ??
      defaultModel;
    const resolved = { provider, model };
    if (json) {
      writer.write(JSON.stringify({ catalog: DISTILLER_CATALOG, resolved }) + '\n');
    } else {
      writer.write(renderDistillerModels({ catalog: DISTILLER_CATALOG, resolved }) + '\n');
    }
    return 0;
  }

  if (isDistill) {
    const dd = opts.distillDeps ?? {};
    const json = parsed.values.json as boolean;

    // Share the progress stream and durable run log identity for this invocation.
    const runId = newRunId();
    const startedAt = new Date().toISOString();
    const invokedAtMs = Date.now();

    // --progress ndjson (#1533): machine-readable run events on stderr, so a
    // wrapper (the harness background runner) can show progress ambiently.
    // stdout stays reserved for the --json result. `run_end` is emitted on
    // every terminal branch — a watcher treats it as the end-of-run signal.
    const progressFlag = parsed.values.progress as string | undefined;
    if (progressFlag !== undefined && progressFlag !== 'ndjson') {
      writer.write(`error: --progress must be "ndjson" (got ${JSON.stringify(progressFlag)})\n\n${USAGE}`);
      return 2;
    }
    const progress =
      progressFlag === 'ndjson'
        ? createNdjsonProgressEmitter(dd.progressStream ?? process.stderr, runId)
        : undefined;
    const endedEmpty = () =>
      progress?.runEnd({ outcome: 'empty', clusterCount: 0, published: [], rejectedCount: 0, errorCount: 0, installed: [] });

    const modePath = distillModePath();
    const persisted = readDistillDefaults(modePath);

    // Distiller provider + model — the arbitrage knob. The model resolved here
    // WRITES the skills; it is deliberately distinct from the cheap runtime
    // model each capture ran under (`environment.model`), which `distill` never
    // touches. Resolution: flag > env > persisted default > provider default.
    const rawProvider =
      (parsed.values.distiller as string | undefined) ??
      process.env['JINN_DISTILL_PROVIDER'] ??
      persisted.distiller ??
      'claude';
    const distillProvider = parseDistillProvider(rawProvider);
    if (!distillProvider) {
      writer.write(`error: distiller must be "claude" or "codex" (got ${JSON.stringify(rawProvider)})\n\n${USAGE}`);
      return 2;
    }
    const defaultDistillModel = distillProvider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_DISTILL_MODEL;
    // The persisted model belongs to the persisted provider. If the effective
    // provider was overridden away from it by a flag/env, the persisted model
    // no longer applies — fall to the new provider's default instead.
    const providerOverridden =
      (parsed.values.distiller as string | undefined) !== undefined ||
      process.env['JINN_DISTILL_PROVIDER'] !== undefined;
    const persistedModel =
      providerOverridden && persisted.distiller !== undefined && persisted.distiller !== distillProvider
        ? undefined
        : persisted.distillerModel;
    const distillModel =
      (parsed.values['distiller-model'] as string | undefined) ??
      process.env['JINN_DISTILL_MODEL'] ??
      persistedModel ??
      defaultDistillModel;
    const clusterTimeoutMs = resolveClusterTimeoutMs(parsed.values['cluster-timeout'] as string | undefined);
    if (typeof clusterTimeoutMs === 'object') {
      writer.write(`${clusterTimeoutMs.error}\n\n${USAGE}`);
      return 2;
    }
    const distill =
      dd.distill ?? (dd.distillerFactory ?? defaultDistillerFactory)(distillProvider, distillModel, clusterTimeoutMs).distill;

    const runsPath = process.env['JINN_LAYER_DISTILL_RUNS_PATH'] ?? DEFAULT_DISTILL_RUNS_PATH;
    const logRun = (
      outcome: DistillRunRecord['outcome'],
      facts: Pick<DistillRunRecord, 'clusterCount' | 'published' | 'rejectedCount' | 'errorCount' | 'installed'>,
    ): void => {
      try {
        appendDistillRun({ runId, startedAt, durationMs: Date.now() - invokedAtMs, outcome, distillModel, ...facts }, runsPath);
      } catch {
        // A local observability failure must never fail the distillation run.
      }
    };
    const emptyFacts = { clusterCount: 0, published: [], rejectedCount: 0, errorCount: 0, installed: [] };

    // Subverbs (#1535 status/runs, #1536 staged/install). Routed before the
    // mode machinery: none of them prompt or spend, and only `install` writes
    // (moving already-produced artifacts out of staging).
    const sub = parsed.positionals[0];
    if (sub !== undefined && sub !== 'runs' && sub !== 'status' && sub !== 'staged' && sub !== 'install') {
      writer.write(`error: unknown distill subcommand ${JSON.stringify(sub)} (expected: run, runs, status, staged, install)\n\n${USAGE}`);
      return 2;
    }
    if (sub === 'staged') {
      const activeDir = (parsed.values.out as string | undefined) ?? DEFAULT_SKILLS_INSTALL_DIR;
      const stagingDir = stagingDirFor(activeDir);
      const staged = listStaged(stagingDir);
      if (json) {
        writer.write(
          JSON.stringify(staged.map((p) => ({ name: p.name, description: p.description, provenance: p.jinn.provenance }))) + '\n',
        );
      } else if (staged.length === 0) {
        writer.write(`nothing staged in ${stagingDir}\n`);
      } else {
        const skills: RenderedSkill[] = staged.map((p) => ({
          name: p.name,
          installed: false,
          provenance: p.jinn.provenance,
          helpsWith: p.description,
        }));
        writer.write(renderSkillsPanel(skills, 'staged — waiting for install') + '\n');
        writer.write(`install with: distill install <name> · distill install --all\n`);
      }
      return 0;
    }

    if (sub === 'install') {
      const activeDir = (parsed.values.out as string | undefined) ?? DEFAULT_SKILLS_INSTALL_DIR;
      const stagingDir = stagingDirFor(activeDir);
      const names = parsed.positionals.slice(1);
      const all = parsed.values.all as boolean;
      if (names.length === 0 && !all) {
        writer.write(`error: distill install needs skill <name>(s) or --all\n\n${USAGE}`);
        return 2;
      }
      const staged = listStaged(stagingDir);
      const byName = new Map(staged.map((p) => [p.name, p]));
      let chosen: SkillPackage[];
      if (all) {
        chosen = staged;
      } else {
        const unknown = names.filter((n) => !byName.has(n));
        if (unknown.length > 0) {
          const available = staged.length > 0 ? staged.map((p) => p.name).join(', ') : 'nothing staged';
          writer.write(`error: not staged: ${unknown.join(', ')} (staged: ${available})\n`);
          return 2;
        }
        chosen = names.map((n) => byName.get(n)!);
      }
      const installed = await installStagedSkills(chosen, stagingDir, activeDir);
      if (json) {
        writer.write(JSON.stringify({ installed, stagingDir, activeDir }) + '\n');
      } else if (installed.length === 0) {
        writer.write(`nothing staged in ${stagingDir}\n`);
      } else {
        writer.write(installed.map((s) => `installed  ${s.name}  →  ${s.path}`).join('\n') + '\n');
      }
      return 0;
    }
    if (sub === 'runs') {
      const limN = Number.parseInt(parsed.values.limit as string, 10);
      const limit = argv.some((a) => a === '--limit' || a.startsWith('--limit=')) && Number.isFinite(limN) && limN > 0 ? limN : 20;
      const runs = readDistillRuns(limit, runsPath);
      if (json) writer.write(JSON.stringify(runs) + '\n');
      else if (runs.length === 0) writer.write('no distill runs recorded yet\n');
      else writer.write(runs.map((r) => `${r.startedAt}  ${r.outcome.padEnd(7)}  ${r.published.length} distilled (${r.published.length > 0 ? r.published.join(', ') : 'no skills'}) · ${r.installed.length} installed · ${r.distillModel}`).join('\n') + '\n');
      return 0;
    }
    if (sub === 'status') {
      const mode = readDistillMode(modePath);
      const statusEpisodesOverride = (parsed.values.episodes as string | undefined) ?? process.env['JINN_LAYER_EPISODES_DIR'];
      const statusLegacyOverride = (parsed.values.captures as string | undefined) ?? process.env['JINN_LAYER_CAPTURES_DIR'];
      const statusLegacyCapturesDir = statusLegacyOverride
        ?? (statusEpisodesOverride ? undefined : DEFAULT_CAPTURES_DIR);
      const statusEpisodesDir = statusEpisodesOverride
        // An explicit legacy source is an isolation boundary as well as a
        // compatibility flag: do not also inspect the operator's default store.
        ?? statusLegacyOverride
        ?? DEFAULT_EPISODES_DIR;
      const statusCaptures = await loadRecentDistillSources({
        episodesDir: statusEpisodesDir,
        ...(statusLegacyCapturesDir ? { legacyCapturesDir: statusLegacyCapturesDir } : {}),
        limit: DEFAULT_DISTILL_CAPTURE_LIMIT,
      });
      const statusActiveDir = (parsed.values.out as string | undefined) ?? DEFAULT_SKILLS_INSTALL_DIR;
      const statusStagingDir = stagingDirFor(statusActiveDir);
      const covered = coveredSessionIds([statusActiveDir, statusStagingDir]);
      const status = {
        mode,
        modePath,
        /** @deprecated Machine compatibility alias for the effective primary source. */
        capturesDir: statusEpisodesDir,
        episodesDir: statusEpisodesDir,
        legacyCapturesDir: statusLegacyCapturesDir ?? null,
        capturesCount: statusCaptures.length,
        uncoveredCount: statusCaptures.filter((capture) => !covered.has(capture.session.sessionId)).length,
        stagingDir: statusStagingDir,
        stagedCount: countSkillDirs(statusStagingDir),
        activeDir: statusActiveDir,
        installedCount: countSkillDirs(statusActiveDir),
        distillProvider,
        distillModel,
        lastRun: readDistillRuns(1, runsPath)[0] ?? null,
      };
      if (json) writer.write(JSON.stringify(status) + '\n');
      else {
        const last = status.lastRun ? `${status.lastRun.startedAt} ${status.lastRun.outcome} (${status.lastRun.published.length} distilled, ${status.lastRun.installed.length} installed)` : 'never';
        writer.write([`mode        ${status.mode}`, `episodes    ${status.capturesCount} available (${status.uncoveredCount} not yet distilled) in ${status.episodesDir}`, `legacy      ${status.legacyCapturesDir ? `read-only compatibility in ${status.legacyCapturesDir}` : 'not requested'}`, `staged      ${status.stagedCount} in ${status.stagingDir}`, `installed   ${status.installedCount} in ${status.activeDir}`, `distiller   ${status.distillProvider} · ${status.distillModel}`, `last run    ${last}`].join('\n') + '\n');
      }
      return 0;
    }

    // 1c — `--where <mode>`: the persistent setter. Scriptable, non-interactive;
    // it records the mode and echoes the resulting behaviour, and runs nothing.
    const whereFlag = parsed.values.where as string | undefined;
    if (whereFlag !== undefined) {
      if (whereFlag !== 'local' && whereFlag !== 'defer' && whereFlag !== 'off') {
        writer.write(`error: --where must be "local", "defer" or "off" (got ${JSON.stringify(whereFlag)})\n\n${USAGE}`);
        return 2;
      }
      writeDistillMode(whereFlag, modePath);
      writer.write((json ? JSON.stringify({ where: whereFlag }) : renderModeSet(whereFlag)) + '\n');
      return 0;
    }

    // 1496 — `--set-distiller[-model]`: the persistent distiller default setter.
    // Scriptable, non-interactive; records the default and echoes it, runs nothing.
    const setProvider = parsed.values['set-distiller'] as string | undefined;
    const setModel = parsed.values['set-distiller-model'] as string | undefined;
    if (setProvider !== undefined || setModel !== undefined) {
      const patch: { distiller?: DistillProvider; distillerModel?: string } = {};
      if (setProvider !== undefined) {
        const provider = parseDistillProvider(setProvider);
        if (!provider) {
          writer.write(`error: distiller must be "claude" or "codex" (got ${JSON.stringify(setProvider)})\n\n${USAGE}`);
          return 2;
        }
        patch.distiller = provider;
      }
      if (setModel !== undefined) {
        if (setModel === '') {
          writer.write(`error: --set-distiller-model must be a non-empty model id\n\n${USAGE}`);
          return 2;
        }
        patch.distillerModel = setModel;
      }
      writeDistillDefaults(patch, modePath);
      writer.write((json ? JSON.stringify(patch) : renderDistillerSet(patch)) + '\n');
      return 0;
    }

    // Source: canonical local episodes plus deprecated CapturedTask reads.
    const episodesOverride =
      (parsed.values.episodes as string | undefined) ??
      process.env['JINN_LAYER_EPISODES_DIR'];
    const legacyOverride =
      (parsed.values.captures as string | undefined) ??
      process.env['JINN_LAYER_CAPTURES_DIR'];
    const legacyCapturesDir = legacyOverride ?? (episodesOverride ? undefined : DEFAULT_CAPTURES_DIR);
    const episodesDir =
      episodesOverride ??
      legacyOverride ??
      DEFAULT_EPISODES_DIR;
    const capN = Number.parseInt(parsed.values.limit as string, 10);
    const capLimit =
      argv.some((a) => a === '--limit' || a.startsWith('--limit=')) && Number.isFinite(capN) && capN > 0
        ? capN
        : DEFAULT_DISTILL_CAPTURE_LIMIT;
    const captures = await loadRecentDistillSources({
      episodesDir,
      ...(legacyCapturesDir ? { legacyCapturesDir } : {}),
      limit: capLimit,
    });

    // 1d — empty: nothing to distill, whatever the mode. Short-circuits consent.
    if (captures.length === 0) {
      if (json) {
        writer.write(JSON.stringify({ clusterCount: 0, distilled: { published: [], rejected: [], errors: [] }, capturesConsidered: 0, distillModel }) + '\n');
      } else {
        writer.write(renderEmpty({ capturesDir: episodesDir }) + '\n');
      }
      endedEmpty();
      logRun('empty', emptyFacts);
      return 0;
    }

    const resume = parsed.values.resume as boolean;
    const mode = readDistillMode(modePath);
    const isTty = dd.isTty ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);

    // Decide the mode this invocation acts on. `--resume` only continues an
    // already-consented LOCAL run — it never grants consent itself, so a
    // `--resume` under any other mode falls through to normal mode handling
    // (unset → first-run consent, defer/off → run nothing). This closes the
    // bypass where `distill --resume` on a fresh machine would spend without ever
    // passing the consent gate.
    let acting: DistillMode;
    if (resume && mode === 'local') {
      acting = 'local';
    } else if (mode === 'unset') {
      const prompt =
        dd.promptConsent ??
        (isTty
          ? () => readlineConsentPrompt({ captureCount: captures.length, distillModel, capturesDir: episodesDir, captures, writer })
          : undefined);
      if (!prompt) {
        // Non-interactive first run: the safe default is defer, and it is NOT
        // persisted — a later interactive run still gets the consent prompt.
        if (json) {
          writer.write(JSON.stringify({ mode: 'defer', ran: false, consent: 'unset', capturesConsidered: captures.length }) + '\n');
        } else {
          writer.write(renderConsentDisclosure({ captureCount: captures.length, distillModel }) + '\n\n');
          writer.write(renderDeferredRun({ captureCount: captures.length, capturesDir: episodesDir }) + '\n');
        }
        endedEmpty();
        return 0;
      }
      const chosen = await prompt();
      writeDistillMode(chosen, modePath);
      writer.write(renderRecorded(chosen, { captureCount: captures.length }) + '\n');
      if (chosen !== 'local') {
        endedEmpty();
        return 0;
      }
      acting = 'local';
    } else {
      acting = mode;
    }

    if (acting === 'off') {
      if (json) writer.write(JSON.stringify({ mode: 'off', ran: false, capturesConsidered: captures.length }) + '\n');
      else writer.write(renderRecorded('off', { captureCount: captures.length }) + '\n');
      endedEmpty();
      return 0;
    }
    if (acting === 'defer') {
      if (json) writer.write(JSON.stringify({ mode: 'defer', ran: false, capturesConsidered: captures.length }) + '\n');
      else writer.write(renderDeferredRun({ captureCount: captures.length, capturesDir: episodesDir }) + '\n');
      endedEmpty();
      return 0;
    }

    // acting === 'local' → distill to STAGING, review, install-on-choice.
    // `--out` is the ACTIVE skills dir (installed skills live here — what /jinn
    // skills and resume read). Distilled-but-not-installed skills wait in a
    // sibling staging dir until the operator installs them; nothing goes live
    // without an explicit choice (the consent-consistent default).
    const activeDir = (parsed.values.out as string | undefined) ?? DEFAULT_SKILLS_INSTALL_DIR;
    const stagingDir = stagingDirFor(activeDir);
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });

    // --resume: distill only captures no distilled skill (installed OR staged)
    // already covers.
    let toDistill = captures;
    if (resume) {
      const covered = coveredSessionIds([activeDir, stagingDir]);
      toDistill = captures.filter((c) => !covered.has(c.session.sessionId));
      if (toDistill.length === 0) {
        if (json) writer.write(JSON.stringify({ mode: 'local', ran: false, resume: true, capturesConsidered: captures.length }) + '\n');
        else writer.write(renderResumeNothing({ captureCount: captures.length }) + '\n');
        endedEmpty();
        logRun('empty', emptyFacts);
        return 0;
      }
    }

    const summaryBySession = new Map(toDistill.map((c) => [c.session.sessionId, c.task.summary]));

    // Progress wiring (#1533): map each cluster back to the source capture's
    // task summary — the label the operator recognises in an ambient tick.
    const labelByCluster = new Map<string, string>();
    const labelFor = (refs: string[]): string | undefined => {
      const sessionId = refs[0]?.replace(/^local-capture:/, '');
      const summary = sessionId === undefined ? undefined : summaryBySession.get(sessionId);
      return summary === undefined ? undefined : summary.length > 80 ? summary.slice(0, 79) + '…' : summary;
    };
    progress?.runStart({
      capturesConsidered: captures.length,
      toDistill: toDistill.length,
      resume,
      distillProvider,
      distillModel,
      capturesDir: episodesDir,
      stagingDir,
      activeDir,
    });

    // Distill to STAGING — nothing is installed yet.
    const distiller = createLocalDistiller({
      distill,
      sink: createLocalSkillSink(stagingDir),
      distribution: 'coding',
      distillModel,
      ...(dd.slateInstanceIds ? { slate: { instanceIds: dd.slateInstanceIds } } : {}),
      ...(progress
        ? {
            onPlan: (plan) => {
              for (const p of plan) {
                const label = labelFor(p.refs);
                if (label !== undefined) labelByCluster.set(p.clusterId, label);
              }
              progress.clusterPlan({
                clusterCount: plan.length,
                clusters: plan.map((p) => ({
                  clusterId: p.clusterId,
                  index: p.index,
                  captureCount: p.captureCount,
                  ...(labelByCluster.has(p.clusterId) ? { label: labelByCluster.get(p.clusterId) } : {}),
                })),
              });
            },
            onCluster: (ev) => {
              const label = labelByCluster.get(ev.clusterId);
              if (ev.phase === 'start') {
                progress.clusterStart({ clusterId: ev.clusterId, index: ev.index, total: ev.total, ...(label !== undefined ? { label } : {}) });
              } else {
                progress.clusterEnd({
                  clusterId: ev.clusterId,
                  index: ev.index,
                  total: ev.total,
                  outcome: ev.outcome ?? 'error',
                  ...(label !== undefined ? { label } : {}),
                  ...(ev.skillName !== undefined ? { skillName: ev.skillName } : {}),
                  ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
                  ...(ev.error !== undefined ? { error: ev.error } : {}),
                  ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
                });
              }
            },
          }
        : {}),
    });
    const result = await distiller.distill(toDistill);
    const published = result.distilled.published;

    // 1d — a run failed mid-way: staged skills are kept, point at --resume. No
    // install is offered on a partial run.
    if (result.distilled.errors.length > 0) {
      if (json) {
        writer.write(JSON.stringify({ ...result, stagingDir, activeDir, installed: [], capturesConsidered: toDistill.length, distillModel }) + '\n');
      } else {
        writer.write(renderFailure({ distillModel, distilledCount: published.length, errors: result.distilled.errors }) + '\n');
      }
      progress?.runEnd({
        outcome: 'partial',
        clusterCount: result.clusterCount,
        published: published.map((p) => p.pkg.name),
        rejectedCount: result.distilled.rejected.length,
        errorCount: result.distilled.errors.length,
        installed: [],
        stagingDir,
      });
      logRun('partial', {
        clusterCount: result.clusterCount,
        published: published.map((p) => p.pkg.name),
        rejectedCount: result.distilled.rejected.length,
        errorCount: result.distilled.errors.length,
        installed: [],
      });
      return 1;
    }

    // Resolve the install choice: --install flag > interactive review/prompt >
    // stage-only. The non-interactive default installs NOTHING — the whole point
    // of decoupling distill from install is that skills go live only on a choice.
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
          progress?.runEnd({
            outcome: 'ok',
            clusterCount: result.clusterCount,
            published: publishedNames,
            rejectedCount: result.distilled.rejected.length,
            errorCount: 0,
            installed: [],
            stagingDir,
          });
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
            ? () => readlineInstallPrompt({ distillModel, captureCount: toDistill.length, skills: reviewSkills, writer })
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
    await installStagedSkills(
      published.filter((p) => installNames.has(p.pkg.name)).map((p) => p.pkg),
      stagingDir,
      activeDir,
    );

    if (json) {
      writer.write(JSON.stringify({
        ...result,
        stagingDir,
        activeDir,
        installed: [...installNames],
        capturesConsidered: toDistill.length,
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
      writer.write(renderRunSummary({ distillModel, captureCount: toDistill.length, skills }) + '\n');
    }
    progress?.runEnd({
      outcome: 'ok',
      clusterCount: result.clusterCount,
      published: publishedNames,
      rejectedCount: result.distilled.rejected.length,
      errorCount: 0,
      installed: [...installNames],
      stagingDir,
    });
    logRun('ok', {
      clusterCount: result.clusterCount,
      published: publishedNames,
      rejectedCount: result.distilled.rejected.length,
      errorCount: 0,
      installed: [...installNames],
    });
    return 0;
  }

  if (isDistillRun || isDistillEvalPrep) {
    const dd = opts.distillRunDeps ?? {};

    // Only honor an EXPLICIT --limit; otherwise fetch the corpus broadly so
    // attempt groups stay complete (#1478) rather than inheriting the 20-row
    // search default (which silently truncates groups mid-instance).
    const userSetLimit = rest.some((a) => a === '--limit' || a.startsWith('--limit='));
    const rawLimit = parsed.values.limit as string;
    const parsedLimit = Number(rawLimit);
    if (
      userSetLimit
      && (
        !/^[0-9]+$/.test(rawLimit)
        || !Number.isSafeInteger(parsedLimit)
        || parsedLimit <= 0
      )
    ) {
      writer.write(`error: --limit must be a positive safe integer (got ${JSON.stringify(rawLimit)})\n\n${USAGE}`);
      return 2;
    }
    const limit = userSetLimit ? parsedLimit : undefined;

    const outDir = (parsed.values.out as string | undefined) ?? mkdtempSync(join(tmpdir(), 'jinn-distill-'));
    mkdirSync(outDir, { recursive: true });
    const localOnly = parsed.values['local-only'] as boolean;
    const anchorMode = parsed.values['anchor-mode'] as string;
    const measurePerRecordControl =
      parsed.values['measure-per-record-control'] as boolean;
    if (anchorMode !== 'per-record' && anchorMode !== 'manifest') {
      writer.write(`error: --anchor-mode must be "per-record" or "manifest" (got ${JSON.stringify(anchorMode)})\n\n${USAGE}`);
      return 2;
    }
    if (localOnly && anchorMode === 'manifest') {
      writer.write(`error: --anchor-mode manifest requires live publish deps and cannot be combined with --local-only\n\n${USAGE}`);
      return 2;
    }
    if (measurePerRecordControl && anchorMode !== 'manifest') {
      writer.write(`error: --measure-per-record-control requires --anchor-mode manifest\n\n${USAGE}`);
      return 2;
    }
    if (measurePerRecordControl && localOnly) {
      writer.write(`error: --measure-per-record-control requires live publish deps and cannot be combined with --local-only\n\n${USAGE}`);
      return 2;
    }

    const rawProvider = (parsed.values.distiller as string | undefined) ?? process.env['JINN_DISTILL_PROVIDER'] ??
      (isDistillEvalPrep ? 'codex' : 'claude');
    const distillProvider = parseDistillProvider(rawProvider);
    if (!distillProvider) {
      writer.write(`error: distiller must be "claude" or "codex" (got ${JSON.stringify(rawProvider)})\n\n${USAGE}`);
      return 2;
    }

    if (!dd.slateInstanceIds) {
      writer.write(
        'error: distill run requires an injected held-out slate; '
          + 'the standalone layer will not guess this safety boundary\n',
      );
      return 2;
    }
    const slateInstanceIds = dd.slateInstanceIds;

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
        const ipfs = createBoundedIpfsJsonFetcher({ gateway });
        const resolveVerifierFacts = dd.verifierFactsResolverFactory?.(ipfs);
        if (!dd.authenticateEnvelope || !dd.resolvePublisherSafe) {
          throw new Error(
            'live evidence fetching requires execution-envelope authentication '
            + 'and ERC-8004 publisher Safe resolution from the production composition root',
          );
        }
        return createEvidenceFetcher({
          ipfs,
          authenticateEnvelope: dd.authenticateEnvelope,
          resolvePublisherSafe: dd.resolvePublisherSafe,
          ...(resolveVerifierFacts ? { resolveVerifierFacts } : {}),
          gql: async (query: string, variables?: Record<string, unknown>) => {
            const res = await fetch(graphqlUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query, variables }),
            });
            const body = (await res.json()) as { data?: unknown; errors?: unknown };
            if (body.errors) throw new Error(`gql: ${JSON.stringify(body.errors)}`);
            return body.data;
          },
        });
      })();

    if (isDistillEvalPrep) {
      const parsePositiveIntFlag = (name: 'max-clusters' | 'max-contrastive' | 'max-lessons' | 'max-patterns'): number | undefined => {
        const raw = parsed.values[name] as string | undefined;
        if (raw === undefined) return undefined;
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`--${name} must be a non-negative integer`);
        }
        return value;
      };
      const parseRequiredPositiveIntFlag = (name: 'group-cap' | 'concurrency'): number | undefined => {
        const raw = parsed.values[name] as string | undefined;
        if (raw === undefined) return undefined;
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`--${name} must be a positive integer`);
        }
        return value;
      };

      const rawModels = (parsed.values.models as string | undefined) ??
        (distillProvider === 'claude'
          ? 'claude-haiku-4-5-20251001,claude-opus-4-8'
          : 'gpt-5.4-mini,gpt-5.5');
      const models = rawModels.split(',').map((m) => m.trim()).filter((m) => m.length > 0);
      const selectOnly = parsed.values['select-only'] as boolean;
      if (!selectOnly && models.length === 0) {
        writer.write(`error: --models must include at least one model\n\n${USAGE}`);
        return 2;
      }

      const distillerFactory = dd.distillerFactory ?? defaultDistillerFactory;
      const modelConfigs = selectOnly ? [] : models.map((model) => {
        const ports = distillerFactory(distillProvider, model);
        return {
          label: modelLabel(model),
          model,
          distill: ports.distill,
          metaDistill: ports.metaDistill,
        };
      });
      const maxClusters = parsePositiveIntFlag('max-clusters');
      const maxContrastive = parsePositiveIntFlag('max-contrastive');
      const maxLessons = parsePositiveIntFlag('max-lessons');
      const maxPatterns = parsePositiveIntFlag('max-patterns');
      const groupCap = parseRequiredPositiveIntFlag('group-cap');
      const concurrency = parseRequiredPositiveIntFlag('concurrency');
      const metaEnabled = parsed.values.meta as boolean;

      let result;
      try {
        result = await runEvalPrep({
          verdictSource,
          fetchEvidence,
          publishDeps: buildLocalOnlyPublishDeps(),
          slate: { instanceIds: slateInstanceIds },
          models: modelConfigs,
          outDir,
          distribution: 'coding',
          selectOnly,
          meta: metaEnabled,
          force: parsed.values.force as boolean,
          retryErrors: parsed.values['retry-errors'] as boolean,
          selection: {
            ...(maxClusters !== undefined ? { maxClusters } : {}),
            ...(maxContrastive !== undefined ? { maxContrastive } : {}),
            ...(maxLessons !== undefined ? { maxLessons } : {}),
            ...(maxPatterns !== undefined ? { maxPatterns } : {}),
          },
          ...(groupCap !== undefined ? { groupCap } : {}),
          ...(concurrency !== undefined ? { concurrency } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      } catch (err) {
        writer.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }

      if (parsed.values.json) {
        writer.write(JSON.stringify({ ...result, outDir }) + '\n');
      } else {
        const lines = [
          `eval-prep: selected ${result.selection.length} of ${result.manifest.clusterCount} cluster(s)`,
          `bridge: ${result.manifest.bridge.bridged} bridged, ${result.manifest.bridge.excludedHeldOut} held-out, ${result.manifest.bridge.deduped} deduped, ${result.manifest.bridge.errors} error(s)`,
          'mode: local-only (no chain publishes or anchors)',
        ];
        if (result.manifest.selectOnly) lines.push('mode: select-only (no model calls)');
        if (result.manifest.bridge.verdictsTruncated) {
          lines.push(`warning: verdict fetch hit the ${limit}-row limit — attempt groups may be PARTIAL; raise --limit to cover the corpus (#1478)`);
        }
        for (const model of result.models) {
          lines.push(
            `model ${model.label} (${model.model}): published ${model.published.length}, rejected ${model.rejected.length}, errors ${model.errors.length}`,
          );
          if (model.metaDistilled) {
            lines.push(
              `  meta: published ${model.metaDistilled.published.length}, rejected ${model.metaDistilled.rejected.length}, errors ${model.metaDistilled.errors.length}`,
            );
          }
        }
        lines.push('', `eval artifacts written under: ${outDir}`);
        writer.write(lines.join('\n') + '\n');
      }

      return result.models.some((m) => m.errors.length > 0 || (m.metaDistilled?.errors.length ?? 0) > 0) ? 1 : 0;
    }

    // Resolve the distiller model once — it drives BOTH the model call and the
    // `distillModel` recorded in provenance (§5), so the record matches the run.
    const defaultDistillModel = distillProvider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_DISTILL_MODEL;
    const distillModel = process.env['JINN_DISTILL_MODEL'] ?? defaultDistillModel;
    const runClusterTimeoutMs = resolveClusterTimeoutMs(parsed.values['cluster-timeout'] as string | undefined);
    if (typeof runClusterTimeoutMs === 'object') {
      writer.write(`${runClusterTimeoutMs.error}\n\n${USAGE}`);
      return 2;
    }
    const distillerFactory = dd.distillerFactory ?? defaultDistillerFactory;
    const distillPorts = dd.distill && dd.metaDistill ? null : distillerFactory(distillProvider, distillModel, runClusterTimeoutMs);
    const distill = dd.distill ?? distillPorts!.distill;
    const metaEnabled = parsed.values.meta as boolean;
    const metaDistillPort = dd.metaDistill ?? distillPorts!.metaDistill;
    if (!localOnly && !dd.publishDeps) {
      writer.write(
        'error: live distillation requires an injected client publish adapter; '
          + 'use --local-only or provide the adapter\n',
      );
      return 2;
    }
    const publishDeps = localOnly
      ? buildLocalOnlyPublishDeps()
      : dd.publishDeps!;

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
      anchorMode,
      ...(measurePerRecordControl ? { measurePerRecordControl: true } : {}),
      ...(metaEnabled ? { meta: true, metaDistill: metaDistillPort } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    if (parsed.values.json) {
      writer.write(JSON.stringify(
        { ...result, outDir },
        (_key, value) => typeof value === 'bigint' ? value.toString() : value,
      ) + '\n');
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
      if (result.bridge.manifestBatches?.length) {
        for (const batch of result.bridge.manifestBatches) {
          if (!batch.confirmed) {
            lines.push(
              `manifest anchor unconfirmed ${batch.manifestCid} at ` +
              `${batch.anchorTx ?? 'unknown'} — ${batch.memberRefs.length} members uploaded; ` +
              'reconcile before retrying',
            );
          } else {
            lines.push(
              `manifest anchored ${batch.manifestCid} at ${batch.anchorTx ?? 'unknown'} — ` +
              `${batch.memberRefs.length} members, ` +
              `gasUsed=${batch.gasUsed?.toString() ?? 'unknown'}, ` +
              `feeWei=${batch.feeWei?.toString() ?? 'unknown'}`,
            );
          }
        }
      }
      if (result.bridge.control) {
        lines.push(
          `per-record control anchored ${result.bridge.control.memberRef} at ` +
          `${result.bridge.control.anchorTx} — ` +
          `gasUsed=${result.bridge.control.gasUsed?.toString() ?? 'unknown'}, ` +
          `feeWei=${result.bridge.control.feeWei?.toString() ?? 'unknown'}`,
        );
      }
      for (const p of result.distilled.published) lines.push(`  PUBLISHED ${p.skillKind} ${p.envelopeRef} (${p.clusterId})`);
      for (const e of result.bridge.errors) lines.push(`  BRIDGE-ERROR ${e.requestId} — ${e.error}`);
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
    return (
      (anchorMode === 'manifest' && result.bridge.errors.length > 0) ||
      result.distilled.errors.length > 0 ||
      (result.metaDistilled?.errors.length ?? 0) > 0
    ) ? 1 : 0;
  }

  if (isDeriveEnv) {
    writer.write(
      'error: derive-env requires the client wallet adapter; '
        + 'the independently published layer does not link wallet code\n',
    );
    return 2;
  }

  if (isPublish) {
    const taskFile = subverb;
    if (taskFile === undefined || taskFile.startsWith('--')) {
      writer.write(`error: publish requires a <task-file> argument (a captured-task JSON file)\n\n${USAGE}`);
      return 2;
    }
    const task = parseCapturedTask(JSON.parse(readFileSync(taskFile, 'utf-8')));
    const pending = await capture(task);
    if (!opts.publishDeps) {
      writer.write(
        'error: publish requires an injected client publish adapter; '
          + 'the standalone layer keeps outbound publication parked\n',
      );
      return 2;
    }
    const deps = opts.publishDeps;
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
      writer.write(JSON.stringify(entries.map(toLedgerRow)) + '\n');
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
    const companions: { path: string; bytes: Buffer }[] = [];
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
      companions.push({ path: file.path, bytes });
    }
    try {
      writePackageTreeSafely(dir, [
        { path: 'SKILL.md', content: skill.skill.skillMd },
        ...companions.map((file) => ({ path: file.path, content: file.bytes })),
      ]);
    } catch (error) {
      writer.write(
        `error: could not safely install skill to ${dir} — ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
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

  if (subverb === 'probe') {
    const slug = parsed.positionals[0];
    if (slug === undefined) {
      writer.write(`error: corpus probe requires a <slug> argument (e.g. "owner/repo")\n\n${USAGE}`);
      return 2;
    }
    const checks = await corpusProbes({ layer, repoSlug: slug, k: CORPUS_ONBOARDING_K });
    if (parsed.values.json) {
      writer.write(JSON.stringify(checks) + '\n');
    } else {
      const lines: string[] = [];
      for (const check of checks) {
        lines.push(`[${check.ok ? 'ok  ' : 'fail'}] ${check.name}: ${check.detail}`);
        if (check.remedy) lines.push(`       remedy: ${check.remedy}`);
      }
      writer.write(lines.join('\n') + '\n');
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
