/**
 * Service Rotator — Decision engine for multi-service rotation
 *
 * Given N services with on-chain activity status, determines which service
 * the worker should currently serve. Rotation happens only between worker
 * poll cycles (never mid-job).
 *
 * Algorithm:
 * 1. Check activity for all staked services
 * 2. Filter to services NOT yet eligible (still need work)
 * 3. Pick the one with the most activitiesNeeded (maximize utilization)
 * 4. If ALL are eligible → stay on current service (extra work doesn't hurt)
 * 5. If NONE are staked → fall back to first service (single-service behavior)
 */

import { logger } from '../../logging/index.js';
import { ActivityMonitor, type ServiceActivityStatus, type ServiceCheckInput } from './ActivityMonitor.js';
import { type ServiceInfo, listServiceConfigs } from '../ServiceConfigReader.js';
import { getActiveService, setActiveService, setAllServices, type ActiveServiceIdentity } from './ActiveServiceContext.js';
import { getServicePrivateKey } from '../../env/operate-profile.js';

const rotationLogger = logger.child({ component: 'SERVICE-ROTATOR' });

export interface RotationDecision {
  service: ServiceInfo;
  reason: string;
  switched: boolean;
  allStatuses: ServiceActivityStatus[];
}

export interface ServiceRotatorOptions {
  rpcUrl: string;
  middlewarePath: string;
  activityPollMs?: number;
  activityCacheTtlMs?: number;
}

export class ServiceRotator {
  private monitor: ActivityMonitor;
  private middlewarePath: string;
  private services: ServiceInfo[] = [];
  private currentServiceConfigId: string | null = null;
  private lastPollAt = 0;
  private pollIntervalMs: number;
  private rotationCount = 0;

  constructor(options: ServiceRotatorOptions) {
    this.monitor = new ActivityMonitor(options.rpcUrl, options.activityCacheTtlMs ?? 60_000);
    this.middlewarePath = options.middlewarePath;
    this.pollIntervalMs = options.activityPollMs ?? 60_000;
  }

  /**
   * Initialize: load all services and select the first active service
   */
  async initialize(): Promise<RotationDecision> {
    // Load configs and filter out incomplete services that can't participate in rotation
    this.services = (await listServiceConfigs(this.middlewarePath))
      .filter(s => s.serviceSafeAddress && s.agentPrivateKey && s.serviceId != null && s.serviceId !== -1);

    // Populate service registry for cross-mech credential resolution in delivery
    setAllServices(this.services);

    const stakedServices = this.services.filter(s => s.stakingContractAddress);
    rotationLogger.info({
      totalServices: this.services.length,
      stakedServices: stakedServices.length,
      serviceIds: stakedServices.map(s => `#${s.serviceId} (${s.serviceConfigId})`),
    }, 'Multi-service rotation initialized');

    if (stakedServices.length === 0) {
      // No staked services — fall back to first service
      const fallback = this.services[0];
      if (!fallback) {
        throw new Error('No services found in .operate/services/');
      }
      this.currentServiceConfigId = fallback.serviceConfigId;
      return {
        service: fallback,
        reason: 'no staked services, using first available',
        switched: false,
        allStatuses: [],
      };
    }

    // Check all staked services and pick the one needing the most work
    return this.reevaluate();
  }

  /**
   * Re-evaluate which service should be active.
   * Called between worker poll cycles.
   */
  async reevaluate(): Promise<RotationDecision> {
    const now = Date.now();

    // Rate-limit activity polls
    if (now - this.lastPollAt < this.pollIntervalMs && this.currentServiceConfigId) {
      const currentService = this.services.find(s => s.serviceConfigId === this.currentServiceConfigId);
      return {
        service: currentService!,
        reason: 'poll interval not reached',
        switched: false,
        allStatuses: [],
      };
    }
    this.lastPollAt = now;

    // Build check inputs from staked services
    const stakedServices = this.services.filter(s =>
      s.stakingContractAddress && s.serviceId && s.serviceSafeAddress
    );

    if (stakedServices.length === 0) {
      const fallback = this.services[0];
      return {
        service: fallback,
        reason: 'no staked services',
        switched: false,
        allStatuses: [],
      };
    }

    const inputs: ServiceCheckInput[] = stakedServices.map(s => ({
      serviceConfigId: s.serviceConfigId,
      serviceId: s.serviceId!,
      multisig: s.serviceSafeAddress!,
      stakingContract: s.stakingContractAddress!,
    }));

    const allStatuses = await this.monitor.checkAllServices(inputs);

    // Find services that still need work (not yet eligible, no errors)
    const needsWork = allStatuses.filter(s => !s.isEligibleForRewards && !s.error);

    // Find services with errors
    const hasErrors = allStatuses.filter(s => s.error);
    if (hasErrors.length > 0) {
      rotationLogger.warn({
        errorServices: hasErrors.map(s => `#${s.serviceId}: ${s.error}`),
      }, 'Some services failed activity check');
    }

    let targetService: ServiceInfo;
    let reason: string;

    if (needsWork.length > 0) {
      // Stay on current service if it still needs work — avoids thrashing between services
      const currentStillNeeds = needsWork.find(s => s.serviceConfigId === this.currentServiceConfigId);
      if (currentStillNeeds) {
        targetService = stakedServices.find(s => s.serviceConfigId === currentStillNeeds.serviceConfigId)!;
        reason = `staying on service #${currentStillNeeds.serviceId} (needs ${currentStillNeeds.activitiesNeeded} more)`;
      } else {
        // Pick the service with the largest deficit.
        // If there is no current service yet, this is an initial selection.
        needsWork.sort((a, b) => b.activitiesNeeded - a.activitiesNeeded);
        const best = needsWork[0];
        targetService = stakedServices.find(s => s.serviceConfigId === best.serviceConfigId)!;
        reason = this.currentServiceConfigId
          ? `current satisfied, switching to service #${best.serviceId} (needs ${best.activitiesNeeded} more)`
          : `initial selection: service #${best.serviceId} (needs ${best.activitiesNeeded} more)`;
      }
    } else {
      // All services are eligible — stay on current or pick first
      const currentInStaked = stakedServices.find(s => s.serviceConfigId === this.currentServiceConfigId);
      targetService = currentInStaked ?? stakedServices[0];
      reason = this.currentServiceConfigId
        ? 'all services eligible for epoch, staying on current'
        : 'all services eligible for epoch, selecting initial service';

      rotationLogger.info({
        serviceCount: stakedServices.length,
        statuses: allStatuses.map(s => ({
          id: s.serviceId,
          eligible: s.isEligibleForRewards,
          activities: s.eligibleActivities,
          required: s.requiredActivities,
        })),
      }, 'All services satisfied for epoch');
    }

    const switched = targetService.serviceConfigId !== this.currentServiceConfigId;
    if (switched) {
      this.rotationCount++;
      rotationLogger.info({
        from: this.currentServiceConfigId,
        to: targetService.serviceConfigId,
        toServiceId: targetService.serviceId,
        reason,
        rotationCount: this.rotationCount,
      }, 'Rotating to new service');
    }

    this.currentServiceConfigId = targetService.serviceConfigId;
    return { service: targetService, reason, switched, allStatuses };
  }

  /**
   * Build an ActiveServiceIdentity from a ServiceInfo
   */
  buildIdentity(service: ServiceInfo): ActiveServiceIdentity {
    if (!service.mechContractAddress || !service.serviceSafeAddress || !service.agentPrivateKey) {
      throw new Error(
        `Service ${service.serviceConfigId} missing required identity fields: ` +
        `mech=${service.mechContractAddress}, safe=${service.serviceSafeAddress}, key=${service.agentPrivateKey ? 'present' : 'missing'}`
      );
    }

    return {
      mechAddress: service.mechContractAddress,
      safeAddress: service.serviceSafeAddress,
      privateKey: service.agentPrivateKey,
      chainConfig: service.chain,
      serviceId: service.serviceId!,
      serviceConfigId: service.serviceConfigId,
      stakingContract: service.stakingContractAddress ?? null,
    };
  }

  /**
   * Get all loaded services (for fund distribution and diagnostics)
   */
  getAllServices(): ServiceInfo[] {
    return [...this.services];
  }

  /**
   * Get all mech addresses across all services (for multi-service mech filtering)
   */
  getAllMechAddresses(): string[] {
    return this.services
      .filter(s => s.mechContractAddress)
      .map(s => s.mechContractAddress!.toLowerCase());
  }

  /**
   * Get observability state
   */
  getState() {
    return {
      currentServiceConfigId: this.currentServiceConfigId,
      totalServices: this.services.length,
      stakedServices: this.services.filter(s => s.stakingContractAddress).length,
      rotationCount: this.rotationCount,
      lastPollAt: this.lastPollAt,
    };
  }
}
