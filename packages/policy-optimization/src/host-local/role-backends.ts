// SPDX-License-Identifier: MIT

import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "@jinn-network/task-execution-backend-local";
import { join, resolve } from "node:path";
import { HostStateError, ensurePrivateDirectory } from "./state.js";

export interface LiveHostIdentitySet {
  readonly solverDelivery: string;
  readonly evaluatorVerdict: string;
  readonly reportAuthor: string;
  readonly journalAuthor: string;
}

export interface LiveHostPurposeKeyBindings {
  readonly solverDelivery: string;
  readonly evaluatorBackendDelivery: string;
  readonly evaluatorVerdict: string;
  readonly reportAuthor: string;
  readonly journalAuthor: string;
}

export interface RoleScopedBackendInput {
  readonly stateRoot: string;
  readonly identities: LiveHostIdentitySet;
  readonly purposeKeys: LiveHostPurposeKeyBindings;
  readonly solver: Omit<LocalTaskExecutionBackendConfig, "stateRoot">;
  readonly evaluator: Omit<LocalTaskExecutionBackendConfig, "stateRoot">;
}

export interface RoleScopedBackends {
  readonly solver: LocalTaskExecutionBackend;
  readonly evaluator: LocalTaskExecutionBackend;
  readonly roots: { readonly solver: string; readonly evaluator: string };
  readonly identities: LiveHostIdentitySet;
  readonly purposeKeys: LiveHostPurposeKeyBindings;
}

function keyId(config: Omit<LocalTaskExecutionBackendConfig, "stateRoot">): string | undefined {
  return config.trustKeys?.deliverySigningKey?.keyId;
}

/** Private host composition: two concrete local backends with disjoint custody and namespaces. */
export function createRoleScopedLocalBackends(input: RoleScopedBackendInput): RoleScopedBackends {
  const identities = Object.values(input.identities);
  if (new Set(identities).size !== identities.length || identities.some((identity) => identity.length === 0)) {
    throw new HostStateError("unsafe-state-path", "solver Delivery, evaluator verdict, Report, and journal identities must be distinct and non-empty");
  }
  if (input.solver.source === input.evaluator.source || input.solver.executor === input.evaluator.executor) {
    throw new HostStateError("unsafe-state-path", "solver and evaluator backend identities must be distinct");
  }
  const solverKey = keyId(input.solver);
  const evaluatorKey = keyId(input.evaluator);
  const purposeKeys = Object.values(input.purposeKeys);
  if (purposeKeys.some((key) => key.length === 0) || new Set(purposeKeys).size !== purposeKeys.length
    || solverKey === undefined || evaluatorKey === undefined
    || solverKey !== input.purposeKeys.solverDelivery
    || evaluatorKey !== input.purposeKeys.evaluatorBackendDelivery) {
    throw new HostStateError("unsafe-state-path", "solver and evaluator require distinct purpose-scoped Delivery signing keys");
  }
  if (input.solver.executor !== input.identities.solverDelivery) {
    throw new HostStateError("unsafe-state-path", "solver Delivery executor must bind the solver Delivery identity");
  }
  const root = ensurePrivateDirectory(input.stateRoot);
  const solverRoot = ensurePrivateDirectory(join(root, "roles", "solver"));
  const evaluatorRoot = ensurePrivateDirectory(join(root, "roles", "evaluator"));
  if (resolve(solverRoot) === resolve(evaluatorRoot)) {
    throw new HostStateError("unsafe-state-path", "solver and evaluator state roots must be exclusive");
  }
  const solver = makeLocalTaskExecutionBackend({ ...input.solver, stateRoot: solverRoot });
  let evaluator: LocalTaskExecutionBackend;
  try {
    evaluator = makeLocalTaskExecutionBackend({ ...input.evaluator, stateRoot: evaluatorRoot });
  } catch (cause) {
    solver.close();
    throw cause;
  }
  return {
    solver,
    evaluator,
    roots: { solver: solverRoot, evaluator: evaluatorRoot },
    identities: { ...input.identities },
    purposeKeys: { ...input.purposeKeys },
  };
}
