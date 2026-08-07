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
  runPreview,
  runQuote,
  sampleInit,
  updateDraft,
} from "@jinn-network/benchmark-product-core";
import type { GuiActionState } from "@/lib/action-state";
import {
  executeOperation,
  field,
  jsonField,
  optionalField,
  positiveIntegerField,
} from "@/lib/server/action-support";
import { ProductContextConfigurationError } from "@/lib/server/product-context";

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
