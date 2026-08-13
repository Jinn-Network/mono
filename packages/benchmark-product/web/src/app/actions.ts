"use server";

import {
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
  selectInspectEvaluation,
  updateDraft,
  type SelectInspectEvaluationInput,
} from "@jinn-network/benchmark-product-core";
import type { GuiActionState } from "@/lib/action-state";
import {
  executeOperation,
  field,
  jsonField,
  optionalField,
  positiveIntegerField,
} from "@/lib/server/action-support";
import { executeBackgroundOperation } from "@/lib/server/background-operation";
import { ProductContextConfigurationError, readProductServerConfiguration, readRunDriverTestingDeps } from "@/lib/server/product-context";
import { projectRunStatusForGui } from "@/lib/server/view-models";
import { projectPublishErrorForGui } from "@/lib/server/gui-error";

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
  return executeOperation((context) => importSweBenchRows(context, {
    draftId,
    rows: jsonField(formData, "rows", []),
  }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

export async function inspectRuntimeSelectAction(
  _previous: GuiActionState,
  formData: FormData,
): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  const configuration = jsonField(formData, "configuration") as Omit<SelectInspectEvaluationInput, "draftId">;
  return executeOperation(
    (context) => selectInspectEvaluation(context, { draftId, ...configuration } as SelectInspectEvaluationInput),
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

export async function runQuoteAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation((context) => runQuote(context, { draftId }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
}

export async function runLockAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
  return executeOperation((context) => runLock(context, { draftId }), { revalidate: ["/workspace", `/workspace/${draftId}`] });
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
  return executeBackgroundOperation(
    "launch",
    (context) => runLaunch(context, { draftId }, readRunDriverTestingDeps()),
    { revalidate: ["/workspace", `/workspace/${draftId}`, `/workspace/${draftId}/run`] },
  );
}

export async function runResumeAction(_previous: GuiActionState, formData: FormData): Promise<GuiActionState> {
  const draftId = field(formData, "draftId");
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
