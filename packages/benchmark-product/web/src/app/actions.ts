"use server";

import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redirect } from "next/navigation";
import {
  anchorAfterLockIfConfigured,
  anchoringConfigure,
  armAdd,
  armList,
  armRemove,
  armUpdate,
  authorityGrant,
  authorityRevoke,
  authorityShow,
  createDraft,
  getDraft,
  importSweBenchRows,
  initWorkspace,
  inspectDraft,
  listDrafts,
  runAnchor,
  runLock,
  publicationAccounting,
  publicationConfigure,
  publicationRegister,
  publicationReport,
  publicationStatus,
  normalizePublicArchiveBaseUrl,
  runLaunch,
  runResume,
  runCancel,
  runStatus,
  runCollect,
  runPreview,
  runPublish,
  runQuote,
  runReport,
  runResults,
  runVerify,
  sampleInit,
  selectMethod,
  profileArmPinning,
  readAgentProfile,
  updateDraft,
  verifyPublicBundle,
} from "@colophon-claims/core";
import type { GuiActionState } from "@/lib/action-state";
import {
  executeOperation,
  field,
  jsonField,
  optionalField,
  positiveIntegerField,
} from "@/lib/server/action-support";
import { executeBackgroundOperation } from "@/lib/server/background-operation";
import {
  ProductContextConfigurationError,
  createProductOperationContext,
  readProductServerConfiguration,
  readRunDriverTestingDeps,
} from "@/lib/server/product-context";
import { projectRunStatusForGui } from "@/lib/server/view-models";
import { projectProductErrorForGui, projectPublishErrorForGui } from "@/lib/server/gui-error";

function failed(outcome: { readonly ok: false; readonly error: Parameters<typeof projectProductErrorForGui>[0] }): GuiActionState {
  return { status: "error", error: projectProductErrorForGui(outcome.error) };
}

async function ensureWorkspaceAndCreateDraft(name: string): Promise<GuiActionState | { readonly draftId: string }> {
  try {
    const context = createProductOperationContext();
    const initialized = initWorkspace(context);
    if (!initialized.ok && initialized.error.code !== "conflict") return failed(initialized);
    const draftId = `local-${randomUUID().slice(0, 12)}`;
    const created = createDraft(context, { draftId, name });
    return created.ok ? { draftId } : failed(created);
  } catch {
    return { status: "error", error: { code: "invalid-invocation", detail: "The local workspace could not be prepared. Check its configured directory and try again." } };
  }
}

function retainedSampleFailure(
  draftId: string,
  stage: string,
  outcome: { readonly ok: false; readonly error: Parameters<typeof projectProductErrorForGui>[0] },
): GuiActionState {
  const projected = projectProductErrorForGui(outcome.error);
  return {
    status: "error",
    error: {
      ...projected,
      detail: `${projected.detail} The sample stopped at ${stage}; retained draft ${draftId} can be opened from Existing work.`,
    },
  };
}

/**
 * Advances the zero-credential sample only through the product's existing durable operations.
 * Every failure names the retained draft; no shadow lifecycle or cleanup path is introduced here.
 */
async function completeGuidedSample(draftId: string): Promise<GuiActionState | { readonly bundleIdentity: string }> {
  const context = createProductOperationContext();
  const quote = await runQuote(context, { draftId });
  if (!quote.ok) return retainedSampleFailure(draftId, "quote", quote);
  const lock = runLock(context, { draftId });
  if (!lock.ok) return retainedSampleFailure(draftId, "lock", lock);
  const launch = await runLaunch(context, { draftId }, readRunDriverTestingDeps());
  if (!launch.ok) return retainedSampleFailure(draftId, "launch", launch);
  const collect = await runCollect(context, { draftId });
  if (!collect.ok) return retainedSampleFailure(draftId, "collect", collect);
  const results = runResults(context, { draftId });
  if (!results.ok) return retainedSampleFailure(draftId, "results", results);
  const report = await runReport(context, { draftId });
  if (!report.ok) return retainedSampleFailure(draftId, "report", report);
  const verified = await runVerify(context, { draftId });
  if (!verified.ok) return retainedSampleFailure(draftId, "verification", verified);
  const published = await runPublish(context, { draftId });
  if (!published.ok) return retainedSampleFailure(draftId, "publication", published);
  return { bundleIdentity: published.result.bundleIdentity };
}

/** Zero-key, one-action sample journey from the three-choice home to a verified report. */
export async function guidedSampleRunAction(_previous: GuiActionState, _formData: FormData): Promise<GuiActionState> {
  void _previous; void _formData;
  const prepared = await ensureWorkspaceAndCreateDraft("Bundled Colophon sample");
  if ("status" in prepared) return prepared;
  const context = createProductOperationContext();
  const sample = await sampleInit(context, prepared);
  if (!sample.ok) return failed(sample);
  for (const arm of [
    { armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } },
    { armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } },
  ] as const) {
    const added = armAdd(context, { draftId: prepared.draftId, ...arm });
    if (!added.ok) return retainedSampleFailure(prepared.draftId, `arm setup (${arm.armId})`, added);
  }
  const completed = await completeGuidedSample(prepared.draftId);
  if ("status" in completed) return completed;
  redirect(`/workspace/${prepared.draftId}/results`);
}

/** Starts an own-work draft without exposing the full draft record form. */
export async function guidedOwnWorkCreateAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  void _previous;
  const name = field(formData, "name");
  if (name.length === 0) return { status: "error", error: { code: "validation", detail: "Name this comparison before continuing." } };
  const prepared = await ensureWorkspaceAndCreateDraft(name);
  if ("status" in prepared) return prepared;
  redirect(`/workspace/${prepared.draftId}`);
}

/** Reader-only choice: authenticate a caller-selected local bundle without opening or mutating it. */
export async function guidedVerifyBundleAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  void _previous;
  const bundle = field(formData, "bundle");
  if (bundle.length === 0 || bundle.includes("\0")) {
    return { status: "error", error: { code: "validation", detail: "Choose the local bundle directory to check." } };
  }
  try {
    const verification = await verifyPublicBundle(resolve(bundle));
    return {
      status: "success",
      result: {
        identity: `sha256:${verification.identity}`,
        checks: verification.checks,
        statement: `${verification.checks.length} of 6 checks passed. The bundle was not uploaded or changed.`,
      },
    };
  } catch {
    return {
      status: "error",
      error: {
        code: "record-integrity",
        detail: "This directory did not pass all six bundle checks. Colophon did not change it or print a verified result.",
      },
    };
  }
}

export async function workspaceInitAction(_previous: GuiActionState, _formData: FormData): Promise<GuiActionState> {
  void _previous; void _formData;
  return executeOperation((context) => initWorkspace(context), { revalidate: ["/workspace"] });
}

export async function draftCreateAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  return executeOperation((context) => createDraft(context, {
    name: field(formData, "name"),
    ...(optionalField(formData, "description") !== undefined
      ? { description: optionalField(formData, "description") }
      : {}),
    ...(optionalField(formData, "draftId") !== undefined ? { draftId: optionalField(formData, "draftId") } : {}),
  }), { revalidate: ["/workspace"] });
}

export async function draftShowAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  return executeOperation((context) => getDraft(context, { draftId: field(formData, "draftId") }));
}

export async function draftListAction(_previous: GuiActionState, _formData: FormData): Promise<GuiActionState> {
  void _previous; void _formData;
  return executeOperation((context) => listDrafts(context));
}

export async function draftUpdateAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation((context) => updateDraft(context, {
    draftId,
    patch: jsonField(formData, "patch", {}),
  }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

export async function draftInspectAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  return executeOperation((context) => inspectDraft(context, { draftId: field(formData, "draftId") }));
}

export async function intakeSampleAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation((context) => sampleInit(context, { draftId }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

export async function intakeSweBenchAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  const file = formData.get("file");
  let rows: unknown;
  if (file instanceof File && file.size > 0) {
    if (file.size > 2_000_000) {
      return { status: "error", error: { code: "validation", detail: "The SWE-bench file is larger than the 2 MB local import limit." } };
    }
    try { rows = JSON.parse(await file.text()); } catch {
      return { status: "error", error: { code: "validation", detail: "The selected SWE-bench file is not valid JSON." } };
    }
  } else {
    rows = jsonField(formData, "rows", []);
  }
  return executeOperation((context) => importSweBenchRows(context, {
    draftId,
    rows,
  }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

export async function methodBindAction(
  _previous: GuiActionState,
  formData: FormData,
): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  const configuration = jsonField(formData, "configuration");
  return executeOperation(
    (context) => {
      const dir = mkdtempSync(join(tmpdir(), "colophon-method-"));
      const filePath = join(dir, "inspect.json");
      writeFileSync(filePath, JSON.stringify(configuration));
      return selectMethod(context, { draftId, ref: filePath, cwd: dir });
    },
    { revalidate: ["/workspace", `/workspace/${draftId}`] },
  );
}

export async function armAddAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation((context) => armAdd(context, {
    draftId,
    armId: field(formData, "armId"),
    pinning: jsonField(formData, "pinning", {}),
    ...(optionalField(formData, "notes") !== undefined ? { notes: optionalField(formData, "notes") } : {}),
  }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

/**
 * Guided own-work seam. The browser selects only a stored profile identifier; the server reads
 * the machine-local profile and compiles its credential-free, digest-bound arm pinning. This is
 * intentionally separate from the advanced raw-pinning action above.
 */
export async function agentProfileArmAddAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  const agentId = field(formData, "agentId");
  return executeOperation((context) => {
    const { agentDataDir } = readProductServerConfiguration();
    const profile = readAgentProfile(agentDataDir, agentId);
    if (profile === undefined) {
      throw new ProductContextConfigurationError("selected Colophon agent profile is no longer configured");
    }
    return armAdd(context, {
      draftId,
      armId: field(formData, "armId"),
      pinning: profileArmPinning(profile),
    });
  }, { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

export async function armUpdateAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const pinning = optionalField(formData, "pinning");
  const draftId = field(formData, "draftId");
  return executeOperation((context) => armUpdate(context, {
    draftId,
    armId: field(formData, "armId"),
    ...(pinning !== undefined ? { pinning: jsonField(formData, "pinning") } : {}),
    ...(optionalField(formData, "notes") !== undefined ? { notes: optionalField(formData, "notes") } : {}),
  }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

export async function armRemoveAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation((context) => armRemove(context, {
    draftId,
    armId: field(formData, "armId"),
  }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

export async function armListAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  return executeOperation((context) => armList(context, { draftId: field(formData, "draftId") }));
}

export async function authorityGrantAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  return executeOperation((context) => {
    const role = optionalField(formData, "role");
    if (role !== undefined && role !== "sponsor" && role !== "delegated-agent") {
      throw new ProductContextConfigurationError("role must be sponsor or delegated-agent");
    }
    return authorityGrant(context, {
      principalId: field(formData, "principalId"),
      ...(role !== undefined ? { role } : {}),
      operations: field(formData, "operations").split(",").map((value) => value.trim()).filter(Boolean),
    });
  }, { revalidate: ["/workspace"] });
}

export async function authorityRevokeAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const operations = optionalField(formData, "operations");
  return executeOperation((context) => authorityRevoke(context, {
    principalId: field(formData, "principalId"),
    ...(operations !== undefined
      ? { operations: operations.split(",").map((value) => value.trim()).filter(Boolean) }
      : {}),
  }), { revalidate: ["/workspace"] });
}

export async function authorityShowAction(_previous: GuiActionState, _formData: FormData): Promise<GuiActionState> {
  void _previous; void _formData;
  return executeOperation((context) => authorityShow(context));
}

export async function runPreviewAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation((context) => {
    const items = positiveIntegerField(formData, "items");
    return runPreview(context, {
      draftId,
      ...(items !== undefined ? { items } : {}),
    });
  }, { revalidate: [`/workspace/${draftId}`] });
}

function draftUsesProviderAgent(draftId: string): boolean {
  try {
    const draft = getDraft(createProductOperationContext(), { draftId });
    if (!draft.ok) return false;
    return draft.result.draft.spec.arms.some((arm) => {
      const harness = arm.pinning.harness;
      const id = typeof harness === "string"
        ? harness
        : typeof harness === "object" && harness !== null && !Array.isArray(harness)
          ? (harness as Readonly<Record<string, unknown>>).id
          : undefined;
      return id === "claude-code" || id === "codex";
    });
  } catch {
    return false;
  }
}

function requireProviderAcknowledgement(draftId: string, formData: FormData): GuiActionState | undefined {
  if (!draftUsesProviderAgent(draftId)) return undefined;
  if (field(formData, "ack-provider-network-costs") === "acknowledged") return undefined;
  return {
    status: "error",
    error: {
      code: "invalid-invocation",
      detail: "Review the provider network and possible-charge boundary, then check the acknowledgement before continuing.",
    },
  };
}

export async function runQuoteAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  const acknowledgement = requireProviderAcknowledgement(draftId, formData);
  if (acknowledgement !== undefined) return acknowledgement;
  return executeOperation((context) => runQuote(context, { draftId }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

/**
 * Lock, then the anchor-evidence design's §7.2 hook — the same call in the same position as the
 * CLI's `lock` verb, so the two surfaces cannot disagree about whether a lock anchors.
 *
 * The outcome is deliberately discarded. `anchorAfterLockIfConfigured` never throws, audits itself,
 * and returns a typed result; folding any of it into this action's state would make the rendered
 * lock outcome depend on a third party being reachable, which is exactly what §7.2 forbids. The
 * durable record is the audit journal, and `run.anchor` re-run standalone returns the typed result.
 */
export async function runLockAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  const acknowledgement = requireProviderAcknowledgement(draftId, formData);
  if (acknowledgement !== undefined) return acknowledgement;
  return executeOperation(async (context) => {
    const locked = runLock(context, { draftId });
    if (locked.ok) await anchorAfterLockIfConfigured(context, draftId);
    return locked;
  }, { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

/**
 * Anchoring is opt-in configuration, and the endpoint is the server's, never the browser's: this
 * deployment reaches whatever is configured here on every later lock. The form carries only the
 * decision — apply the server's configured providers, or clear the block.
 *
 * The result names the configured **profiles only**. An endpoint is a URL an operator typed, and a
 * URL can carry userinfo or a key in its path or query; this action's success state is serialized
 * into the browser, so it carries the fact the operator needs (which providers are configured) and
 * not the credential-shaped string behind it.
 */
export async function anchoringConfigureAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const clearing = field(formData, "clear") === "clear-anchoring";
  const applied = await executeOperation((context) => {
    if (clearing) return anchoringConfigure(context, { entries: [] });
    const configured = readProductServerConfiguration().anchorProviders;
    if (configured === undefined) throw new ProductContextConfigurationError("The server must configure anchor providers before the GUI can enable anchoring");
    return anchoringConfigure(context, { entries: configured });
  }, { revalidate: ["/workspace"] });
  if (applied.status !== "success") return applied;
  const anchoring = (applied.result as { readonly anchoring: readonly { readonly providerProfile: string }[] }).anchoring;
  return { status: "success", result: { providerProfiles: anchoring.map((entry) => entry.providerProfile) } };
}

/**
 * Anchors one of a run's own sealed records. Provider and endpoint are resolved from workspace
 * configuration; the browser names only the draft and which record to anchor.
 */
export async function runAnchorAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  const subject = field(formData, "subject");
  return executeOperation(async (context) => {
    if (subject !== "lock" && subject !== "matrix") {
      throw new ProductContextConfigurationError("subject must be lock or matrix");
    }
    return runAnchor(context, { draftId, subject });
  }, { revalidate: [`/workspace/${draftId}`, `/workspace/${draftId}/run`] });
}

/** The browser supplies a locator and draft id only. The workspace is fixed by server config. */
export async function publicationConfigureAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation((context) => {
    const configured = readProductServerConfiguration().publicationPublicBaseUrl;
    if (configured === undefined) throw new ProductContextConfigurationError("The server must configure a publication public base URL before the GUI can publish");
    return publicationConfigure(context, { draftId, publicBaseUrl: configured });
  }, { revalidate: [`/workspace/${draftId}`, `/workspace/${draftId}/run`] });
}

export async function publicationRegisterAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation((context) => {
    const configured = readProductServerConfiguration().publicationPublicBaseUrl;
    if (configured === undefined) throw new ProductContextConfigurationError("The server must configure a publication public base URL before the GUI can publish");
    return publicationRegister(context, { draftId, publicBaseUrl: configured });
  }, { revalidate: [`/workspace/${draftId}`, `/workspace/${draftId}/run`] });
}

export async function publicationStatusAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  return executeOperation((context) => publicationStatus(context, { draftId: field(formData, "draftId") }));
}

export async function publicationAccountingAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation(async (context) => publicationAccounting(context, { draftId }), {
    revalidate: [`/workspace/${draftId}`, `/workspace/${draftId}/run`, `/workspace/${draftId}/results`],
  });
}

/** Publishing a signed interpretation is an explicit, server-owned consent action. The browser
 * supplies only the draft and acknowledgement; source locator and workspace authority stay server-side. */
export async function publicationReportAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  if (field(formData, "consent") !== "publish-signed-report-v2") {
    throw new ProductContextConfigurationError("Confirm signed Report v2 publication before continuing");
  }
  return executeOperation(async (context) => {
    const configured = readProductServerConfiguration().publicationPublicBaseUrl;
    if (configured === undefined) throw new ProductContextConfigurationError("The server must configure a publication public base URL before the GUI can publish");
    const status = publicationStatus(context, { draftId });
    if (!status.ok) return status;
    if (status.result.publicBaseUrl === undefined
      || normalizePublicArchiveBaseUrl(status.result.publicBaseUrl) !== configured) {
      throw new ProductContextConfigurationError("The server-configured public archive mount must match the run's configured publication locator before a signed Report v2 can publish");
    }
    return publicationReport(context, { draftId });
  }, {
    revalidate: [`/workspace/${draftId}`, `/workspace/${draftId}/run`, `/workspace/${draftId}/results`],
  });
}

export async function runLaunchAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  const acknowledgement = requireProviderAcknowledgement(draftId, formData);
  if (acknowledgement !== undefined) return acknowledgement;
  return executeBackgroundOperation(
    "launch",
    (context) => runLaunch(context, { draftId }, readRunDriverTestingDeps()),
    { revalidate: ["/workspace", `/workspace/${draftId}`, `/workspace/${draftId}/run`] },
  );
}

export async function runResumeAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  const acknowledgement = requireProviderAcknowledgement(draftId, formData);
  if (acknowledgement !== undefined) return acknowledgement;
  return executeBackgroundOperation(
    "resume",
    (context) => runResume(context, { draftId }, readRunDriverTestingDeps()),
    { revalidate: ["/workspace", `/workspace/${draftId}`, `/workspace/${draftId}/run`] },
  );
}

export async function runStatusAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  return executeOperation((context) => {
    const outcome = runStatus(context, { draftId: field(formData, "draftId") });
    return outcome.ok ? { ...outcome, result: projectRunStatusForGui(outcome.result) } : outcome;
  });
}

export async function runCancelAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation(
    (context) => runCancel(context, { draftId }),
    { revalidate: ["/workspace", `/workspace/${draftId}`, `/workspace/${draftId}/run`] },
  );
}

export async function runCollectAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation(
    (context) => runCollect(context, { draftId }),
    { revalidate: ["/workspace", `/workspace/${draftId}`, `/workspace/${draftId}/run`] },
  );
}

export async function runResultsAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation(
    (context) => {
      const outcome = runResults(context, { draftId });
      if (!outcome.ok) return outcome;
      return {
        ok: true as const,
        result: {
          draftId: outcome.result.draftId,
          matrixSha256: outcome.result.matrixSha256,
          runOutcome: outcome.result.runOutcome,
          expected: outcome.result.completeness.expected,
          judged: outcome.result.completeness.judged,
          reportAvailable: outcome.result.report !== undefined,
        },
      };
    },
    { revalidate: [`/workspace/${draftId}/results`] },
  );
}

export async function runReportAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation(
    async (context) => {
      const outcome = await runReport(context, { draftId });
      if (!outcome.ok) return outcome;
      return {
        ok: true as const,
        result: {
          draftId,
          state: outcome.result.draft.state,
          reportSha256: outcome.result.reportSha256,
          reportEnvelopeSha256: outcome.result.reportEnvelopeSha256,
          preregistered: outcome.result.preregistered,
        },
      };
    },
    { revalidate: ["/workspace", `/workspace/${draftId}`, `/workspace/${draftId}/run`, `/workspace/${draftId}/results`] },
  );
}

export async function runVerifyAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation(async (context) => {
    const outcome = await runVerify(context, { draftId });
    if (!outcome.ok) return outcome;
    return {
      ok: true as const,
      result: {
        draftId,
        checks: [...outcome.result.checks],
        matrixSha256: outcome.result.matrixSha256,
        ...(outcome.result.reportEnvelopeSha256 !== undefined
          ? { reportEnvelopeSha256: outcome.result.reportEnvelopeSha256 }
          : {}),
      },
    };
  });
}

/** Publishes, or re-verifies the one fixed draft-owned bundle when already published. The
 * browser supplies only draftId — never a filesystem path — and receives no absolute path. */
export async function runPublishAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation(async (context) => {
    const outcome = await runPublish(context, {
      draftId,
      ...(formData.get("includeNativeArtifacts") === "on" ? { includeNativeArtifacts: true } : {}),
    });
    if (!outcome.ok) return { ...outcome, error: projectPublishErrorForGui(outcome.error) };
    return {
      ok: true as const,
      result: {
        draftId,
        state: outcome.result.draft.state,
        bundleIdentity: outcome.result.bundleIdentity,
        bundleRelativePath: outcome.result.bundleRelativePath,
        checks: [...outcome.result.checks],
      },
    };
  }, { revalidate: ["/workspace", `/workspace/${draftId}`, `/workspace/${draftId}/results`] });
}
