import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JinnConfig } from '../config.js';
import { DEFAULT_TESTNET_ARTIFACTS, getChainConfig } from '../earning/contracts.js';
import { parseFleetStateJson, STATE_FILE } from '../earning/store.js';
import { isOperationalServiceStep, type FleetState, type ServiceState } from '../earning/types.js';

export interface TaskNativeReadiness {
  ok: boolean;
  solverReady: boolean;
  evaluatorReady: boolean;
  evaluatorRoleReady: boolean;
  distinctEvaluatorServiceReady: boolean;
  detail: string;
  remedy?: string;
  source: string | null;
  contracts: {
    taskCoordinator?: string;
    jinnRouterV3?: string;
    taskActivityCheckerV3?: string;
  };
  routerClaimDeliveryVersion?: 'v1' | 'v2' | 'v3';
  operatorState?: {
    statePath: string;
    chain?: 'base' | 'base-sepolia';
    services: number;
    taskNativeServices: number;
    activeSafe?: string;
    activeMech?: string;
    evaluatorSafe?: string;
    evaluatorMech?: string;
    distinctEvaluatorServiceReady: boolean;
  };
}

function isNonZeroAddress(value: unknown): value is string {
  return typeof value === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(value) &&
    value.toLowerCase() !== '0x0000000000000000000000000000000000000000';
}

function bundledTaskNativeDeploymentPath(): string {
  return process.env['JINN_TESTNET_TASK_COORDINATOR_ROUTER_V3_DEPLOYMENT'] ??
    DEFAULT_TESTNET_ARTIFACTS.taskCoordinatorRouterV3;
}

function taskNativeStatePath(config: JinnConfig): string {
  return join(config.earningDir, STATE_FILE);
}

function isTaskNativeService(service: ServiceState): boolean {
  return isOperationalServiceStep(service.step) &&
    service.service_id !== null &&
    isNonZeroAddress(service.safe_address) &&
    isNonZeroAddress(service.mech_address);
}

/**
 * Returns true iff the operator has joined at least one SolverNet with the
 * `evaluator` role. Exported so the joined-only branch (issue #421) can be
 * regression-tested in isolation from the wider `resolveTaskNativeReadiness`
 * surface, which short-circuits on mainnet before reaching this helper.
 */
export function hasConfiguredEvaluatorRole(config: JinnConfig): boolean {
  if (config.evaluator?.enabled === true) return true;
  return (config.executionWiring ?? []).some((entry) => entry.harness.includes('evaluator'));
}

function loadFleetState(config: JinnConfig): { path: string; state: FleetState | null; error?: string } {
  const path = taskNativeStatePath(config);
  if (!existsSync(path)) {
    return { path, state: null, error: 'earning state file is missing' };
  }
  try {
    const state = parseFleetStateJson(readFileSync(path, 'utf8'));
    return state
      ? { path, state }
      : { path, state: null, error: 'earning state file is not a current fleet-state schema' };
  } catch (err) {
    return {
      path,
      state: null,
      error: `earning state file could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function resolveTaskNativeReadiness(config: JinnConfig): TaskNativeReadiness {
  const chain = config.network === 'testnet' ? 'base-sepolia' : 'base';
  const source = config.network === 'testnet' ? bundledTaskNativeDeploymentPath() : null;
  if (!source || !existsSync(source)) {
    return {
      ok: false,
      solverReady: false,
      evaluatorReady: false,
      evaluatorRoleReady: false,
      distinctEvaluatorServiceReady: false,
      detail:
        source
          ? `Task-native deployment artifact is not bundled at ${source}`
          : `Task-native deployment artifact is not bundled for ${chain}`,
      remedy:
        'Bundle deployment-task-coordinator-router-v3-baseSepolia-fast.json or configure a network release with TaskCoordinator/JinnRouterV3/TaskActivityCheckerV3.',
      source,
      contracts: {},
    };
  }

  let chainCfg: ReturnType<typeof getChainConfig>;
  try {
    chainCfg = getChainConfig(chain, {
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    });
  } catch (err) {
    return {
      ok: false,
      solverReady: false,
      evaluatorReady: false,
      evaluatorRoleReady: false,
      distinctEvaluatorServiceReady: false,
      detail: `Task-native deployment config could not be resolved: ${
        err instanceof Error ? err.message : String(err)
      }`,
      remedy: 'Verify bundled deployment artifacts and deployment path overrides.',
      source,
      contracts: {},
    };
  }

  let artifact: { contracts?: Record<string, unknown> };
  try {
    artifact = JSON.parse(readFileSync(source, 'utf8')) as {
      contracts?: Record<string, unknown>;
    };
  } catch (err) {
    return {
      ok: false,
      solverReady: false,
      evaluatorReady: false,
      evaluatorRoleReady: false,
      distinctEvaluatorServiceReady: false,
      detail: `Task-native deployment artifact could not be parsed at ${source}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      remedy: 'Refresh the bundled TaskCoordinator/JinnRouterV3 deployment artifact.',
      source,
      contracts: {},
      routerClaimDeliveryVersion: chainCfg.routerClaimDeliveryVersion,
    };
  }

  const contracts = artifact.contracts ?? {};
  const taskCoordinator = contracts['taskCoordinator'];
  const jinnRouterV3 = contracts['jinnRouterV3'];
  const taskActivityCheckerV3 = contracts['activityChecker'];
  const resolvedContracts = {
    ...(isNonZeroAddress(taskCoordinator) ? { taskCoordinator } : {}),
    ...(isNonZeroAddress(jinnRouterV3) ? { jinnRouterV3 } : {}),
    ...(isNonZeroAddress(taskActivityCheckerV3) ? { taskActivityCheckerV3 } : {}),
  };
  const missingContracts = [
    isNonZeroAddress(taskCoordinator) ? null : 'TaskCoordinator',
    isNonZeroAddress(jinnRouterV3) ? null : 'JinnRouterV3',
    isNonZeroAddress(taskActivityCheckerV3) ? null : 'TaskActivityCheckerV3',
  ].filter((part): part is string => part !== null);
  const routerMatchesConfig =
    isNonZeroAddress(jinnRouterV3) &&
    isNonZeroAddress(chainCfg.jinnRouter) &&
    chainCfg.jinnRouter.toLowerCase() === jinnRouterV3.toLowerCase();
  const claimVariantReady = chainCfg.routerClaimDeliveryVersion === 'v3';
  const deploymentReady = missingContracts.length === 0 && routerMatchesConfig && claimVariantReady;

  const stateLoad = loadFleetState(config);
  const expectedFleetChain = chain;
  const state = stateLoad.state;
  const taskNativeServices = state?.services.filter(isTaskNativeService) ?? [];
  const active = taskNativeServices[0];
  const evaluator = active
    ? taskNativeServices.find((svc) => svc.safe_address!.toLowerCase() !== active.safe_address!.toLowerCase())
    : undefined;
  const configuredEvaluatorRole = hasConfiguredEvaluatorRole(config);
  const stateChainReady = state?.chain === expectedFleetChain;
  const operatorState = {
    statePath: stateLoad.path,
    ...(state?.chain ? { chain: state.chain } : {}),
    services: state?.services.length ?? 0,
    taskNativeServices: taskNativeServices.length,
    ...(active?.safe_address ? { activeSafe: active.safe_address } : {}),
    ...(active?.mech_address ? { activeMech: active.mech_address } : {}),
    ...(evaluator?.safe_address ? { evaluatorSafe: evaluator.safe_address } : {}),
    ...(evaluator?.mech_address ? { evaluatorMech: evaluator.mech_address } : {}),
    distinctEvaluatorServiceReady: Boolean(evaluator),
  };

  const stateIssues = [
    stateLoad.error ?? null,
    state && !stateChainReady ? `earning state chain is ${state.chain}, expected ${expectedFleetChain}` : null,
    state && taskNativeServices.length === 0
      ? 'no operational service has service_id, Safe, and Mech addresses'
      : null,
  ].filter((part): part is string => part !== null);
  const deploymentIssues = [
    missingContracts.length > 0 ? `missing ${missingContracts.join(', ')}` : null,
    routerMatchesConfig ? null : 'resolved chain config does not point at bundled JinnRouterV3',
    claimVariantReady ? null : `router claim variant is ${chainCfg.routerClaimDeliveryVersion}, expected v3`,
  ].filter((part): part is string => part !== null);

  const solverReady = deploymentReady && stateChainReady && Boolean(active);
  const evaluatorRoleReady = solverReady && configuredEvaluatorRole;
  const distinctEvaluatorServiceReady = solverReady && Boolean(evaluator);
  const evaluatorReady = evaluatorRoleReady;
  const evaluatorRoleDetail = evaluatorRoleReady
    ? 'evaluator-role=ready'
    : 'evaluator-role=not-ready (operator has not joined any evaluator role)';
  const evaluatorTopologyDetail = distinctEvaluatorServiceReady
    ? `evaluator-topology=distinct evaluatorSafe=${evaluator!.safe_address} evaluatorMech=${evaluator!.mech_address}`
    : 'evaluator-topology=same-service (no distinct evaluator Safe/Mech configured)';
  const detail = solverReady
    ? `Task-native solver-ready=true evaluator-ready=${evaluatorReady ? 'true' : 'false'} ${evaluatorRoleDetail}; ${evaluatorTopologyDetail} on ${chain}: TaskCoordinator=${taskCoordinator}, JinnRouterV3=${jinnRouterV3}, TaskActivityCheckerV3=${taskActivityCheckerV3}; activeSafe=${active!.safe_address} activeMech=${active!.mech_address}`
    : `Task-native not ready on ${chain}: ${[...deploymentIssues, ...stateIssues].join('; ')}`;

  return {
    ok: solverReady,
    solverReady,
    evaluatorReady,
    evaluatorRoleReady,
    distinctEvaluatorServiceReady,
    detail,
    ...(solverReady
      ? {}
      : {
          remedy:
            'Use bundled TaskCoordinator/JinnRouterV3/TaskActivityCheckerV3 artifacts and an existing operational service with Safe and Mech addresses before Task-native participation.',
        }),
    source,
    contracts: resolvedContracts,
    routerClaimDeliveryVersion: chainCfg.routerClaimDeliveryVersion,
    operatorState,
  };
}
