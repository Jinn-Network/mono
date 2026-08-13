import { createHash } from "node:crypto";
import type {
  PublicationAction, PublicationArtifact, PublicationExecutionReceipt, PublicationJournal,
  PublicationPlan, PublicationRecord, RecordPublicationDependencies, Sha256Digest,
} from "./types.js";
import { PublicationPlanError } from "./types.js";

const encoder = new TextEncoder();
const STAGES = ["registration", "accounting", "report"] as const;
type Member = PublicationRecord | PublicationArtifact;

export function sha256(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isRecord(member: Member): member is PublicationRecord { return "kind" in member; }
function isAbsoluteIri(value: unknown): value is string {
  try { const parsed = new URL(typeof value === "string" ? value : ""); return parsed.protocol.length > 1 && parsed.username.length === 0 && parsed.password.length === 0; } catch { return false; }
}
function key(member: Member, action: PublicationAction): Sha256Digest {
  return sha256(encoder.encode(JSON.stringify({
    v: 1, id: member.id, digest: member.digest, action,
    ...(isRecord(member) ? { kind: member.kind, authority: member.authority.mode, origin: member.authority.origin ?? null } : { role: member.role }),
  })));
}

function planFingerprint(plan: PublicationPlan, members: readonly Member[]): Sha256Digest {
  return sha256(encoder.encode(JSON.stringify({
    v: 1, id: plan.id,
    stages: plan.stages.map(({ stage, members: stageMembers }) => ({ stage, members: stageMembers.map((member) => ({
      id: member.id, digest: member.digest, bytes: Buffer.from(member.bytes).toString("base64"), mediaType: member.mediaType,
      actions: member.actions, dependsOn: member.dependsOn ?? [],
      ...(isRecord(member) ? { kind: member.kind, authority: member.authority } : { role: member.role }),
    })) })),
    actionKeys: members.flatMap((member) => member.actions.map((action) => key(member, action))),
  })));
}

function validate(plan: PublicationPlan): Member[] {
  if (!plan || typeof plan.id !== "string" || plan.id.length === 0 || !Array.isArray(plan.stages) || plan.stages.length === 0) {
    throw new PublicationPlanError("INVALID_PLAN", "A plan needs a non-empty id and stages.");
  }
  let previous = -1; const members: Member[] = []; const ids = new Set<string>();
  for (const stage of plan.stages) {
    const ordinal = STAGES.indexOf(stage.stage);
    if (ordinal < 0 || ordinal <= previous || !Array.isArray(stage.members) || stage.members.length === 0) {
      throw new PublicationPlanError("INVALID_PLAN", "Plan stages must be non-empty and ordered registration, accounting, report.");
    }
    previous = ordinal;
    for (const member of stage.members) {
      if (!member || typeof member.id !== "string" || member.id.length === 0 || ids.has(member.id) ||
        typeof member.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(member.digest) ||
        !(member.bytes instanceof Uint8Array) || typeof member.mediaType !== "string" || member.mediaType.length === 0 ||
        !Array.isArray(member.actions) || member.actions.length === 0 || new Set(member.actions).size !== member.actions.length || sha256(member.bytes) !== member.digest) {
        throw new PublicationPlanError("INVALID_PLAN", "Each plan member needs unique id, exact digest-matching bytes, media type, and actions.");
      }
      if (!isRecord(member) && (!isAbsoluteIri(member.role) || member.actions.some((action: PublicationAction) => action === "announce" || action === "verify-origin"))) {
        throw new PublicationPlanError("INVALID_PLAN", "Artifacts have an absolute role and may only store or mirror.");
      }
      if (isRecord(member)) {
        if (!isAbsoluteIri(member.kind) || !member.authority || !["owner", "delegate", "origin-reference"].includes(member.authority.mode)) {
          throw new PublicationPlanError("INVALID_PLAN", "Records need a kind and an authority mode.");
        }
        const originMode = member.authority.mode === "origin-reference";
        if (originMode !== (member.authority.origin !== undefined) || (originMode && (!member.actions.includes("verify-origin") || member.actions.includes("announce")))) {
          throw new PublicationPlanError("INVALID_PLAN", "Origin references require verification and cannot be locally announced.");
        }
        if (originMode && (!member.authority.origin || typeof member.authority.origin.source.agent !== "string" || member.authority.origin.source.agent.length === 0 || typeof member.authority.origin.source.name !== "string" || member.authority.origin.source.name.length === 0 || !/^[0-9]{16}$/u.test(member.authority.origin.sequence) || !/^sha256:[a-f0-9]{64}$/u.test(member.authority.origin.entryDigest))) {
          throw new PublicationPlanError("INVALID_PLAN", "Origin references need an exact source position.");
        }
        if (!originMode && (member.actions.includes("verify-origin") || (member.actions.includes("announce") && !["owner", "delegate"].includes(member.authority.mode)))) {
          throw new PublicationPlanError("INVALID_PLAN", "Only owner/delegate records may be announced.");
        }
      }
      ids.add(member.id); members.push(member);
    }
  }
  for (const member of members) for (const dependency of member.dependsOn ?? []) {
    if (!ids.has(dependency) || dependency === member.id) throw new PublicationPlanError("INVALID_PLAN", `Unknown dependency ${dependency}.`);
  }
  return members;
}

function ordered(plan: PublicationPlan, members: readonly Member[]): { member: Member; action: PublicationAction; id: Sha256Digest }[] {
  const stageOf = new Map(plan.stages.flatMap(({ stage, members: stageMembers }) => stageMembers.map((member) => [member.id, STAGES.indexOf(stage)] as const)));
  const complete = new Set<string>(); const output: Member[] = [];
  while (output.length < members.length) {
    const earliest = Math.min(...members.filter((member) => !complete.has(member.id)).map((member) => stageOf.get(member.id)!));
    const ready = members.filter((member) => stageOf.get(member.id) === earliest && !complete.has(member.id) && (member.dependsOn ?? []).every((dependency) => complete.has(dependency)));
    if (ready.length === 0) throw new PublicationPlanError("INVALID_PLAN", "Plan dependencies contain a cycle.");
    ready.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const member of ready) { complete.add(member.id); output.push(member); }
  }
  const actionOrder: Record<PublicationAction, number> = { store: 0, "verify-origin": 1, mirror: 2, announce: 3 };
  return output.flatMap((member) => [...member.actions].sort((left, right) => actionOrder[left] - actionOrder[right]).map((action) => ({ member, action, id: key(member, action) })));
}

async function checkpoint(planId: string, current: { revision: string; value: PublicationJournal }, next: PublicationJournal, deps: RecordPublicationDependencies): Promise<{ revision: string; value: PublicationJournal }> {
  const result = await deps.journal.compareAndSwap(planId, current.revision, next);
  if (result.ok) return { revision: result.revision, value: next };
  const raced = await deps.journal.read(planId);
  if (raced === undefined) throw new PublicationPlanError("JOURNAL_CONFLICT", "Publication journal disappeared during a CAS race.");
  return raced;
}

export async function executePublicationPlan(plan: PublicationPlan, deps: RecordPublicationDependencies): Promise<PublicationExecutionReceipt> {
  const members = validate(plan); const fingerprint = planFingerprint(plan, members); const operations = ordered(plan, members);
  let state = await deps.journal.read(plan.id);
  if (state === undefined) {
    const initial: PublicationJournal = { version: 1, planId: plan.id, fingerprint, completed: [], complete: false };
    const created = await deps.journal.compareAndSwap(plan.id, null, initial);
    state = created.ok ? { revision: created.revision, value: initial } : await deps.journal.read(plan.id);
    if (state === undefined) throw new PublicationPlanError("JOURNAL_CONFLICT", "Unable to claim publication journal.");
  }
  if (state.value.version !== 1 || state.value.planId !== plan.id || state.value.fingerprint !== fingerprint || state.value.completed.some((id) => !operations.some((operation) => operation.id === id))) {
    throw new PublicationPlanError(state.value.fingerprint === fingerprint ? "JOURNAL_CORRUPT" : "PLAN_CONFLICT", "Publication journal does not match this exact plan.");
  }
  for (const operation of operations) {
    if (state.value.completed.includes(operation.id)) continue;
    if (operation.action === "store" || operation.action === "mirror") {
      if (deps.destination !== undefined) await deps.destination.deliver({ idempotencyKey: operation.id, member: operation.member, action: operation.action });
      else await deps.objects.putExact({ digest: operation.member.digest, bytes: new Uint8Array(operation.member.bytes), mediaType: operation.member.mediaType });
    } else if (operation.action === "announce") {
      if (deps.announce === undefined || deps.authority === undefined || !isRecord(operation.member) || operation.member.authority.mode === "origin-reference") throw new PublicationPlanError("PORT_MISSING", "Announcement action requires an authorization and announcement port.");
      await deps.authority.authorizeAnnouncement({ record: operation.member, mode: operation.member.authority.mode });
      await deps.announce.announce({ idempotencyKey: operation.id, record: operation.member });
    } else {
      if (deps.verifyOrigin === undefined || !isRecord(operation.member) || operation.member.authority.origin === undefined) throw new PublicationPlanError("PORT_MISSING", "Origin verification action requires an origin-verification port.");
      await deps.verifyOrigin.verifyOrigin({ record: operation.member, origin: operation.member.authority.origin });
    }
    await deps.faults?.at({ action: operation.action, idempotencyKey: operation.id });
    state = await checkpoint(plan.id, state, { ...state.value, completed: [...state.value.completed, operation.id] }, deps);
  }
  if (!state.value.complete) state = await checkpoint(plan.id, state, { ...state.value, complete: true }, deps);
  return { planId: plan.id, fingerprint, completed: state.value.completed, complete: true };
}

export function validatePublicationPlan(plan: PublicationPlan): void { validate(plan); ordered(plan, validate(plan)); }
