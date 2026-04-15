/**
 * Olas Staking Manager
 *
 * Manages automated OLAS token staking operations for the Jinn worker system.
 * Now uses the OlasOperateWrapper-based service lifecycle management.
 *
 * Refactored for JINN-180: Remove SafeExecutor dependencies
 */

import "dotenv/config";
import { OlasOperateWrapper } from "./OlasOperateWrapper.js";
import { logger } from '../logging/index.js';
import {
  OlasServiceManager,
  ServiceLifecycleTransition,
  ServiceManagerConfig,
} from "./OlasServiceManager.js";

const stakingLogger = logger.child({ component: "OLAS-STAKING" });

export class OlasStakingManager {
  private operateWrapper: OlasOperateWrapper;
  private serviceManager: OlasServiceManager | null = null;

  constructor(operateWrapper: OlasOperateWrapper) {
    if (!operateWrapper) {
      throw new Error(
        "OlasStakingManager requires OlasOperateWrapper instance",
      );
    }

    this.operateWrapper = operateWrapper;

    stakingLogger.info(
      "OlasStakingManager initialized with operate wrapper",
    );
  }

  setServiceManager(manager: OlasServiceManager): void {
    this.serviceManager = manager;
  }

  getServiceManager(): OlasServiceManager | null {
    return this.serviceManager;
  }

  async ensureServiceManager(options: ServiceManagerConfig = {}): Promise<OlasServiceManager> {
    if (this.serviceManager) {
      return this.serviceManager;
    }

    // Pass the operateWrapper to ensure consistent operate CLI usage
    const finalOptions: ServiceManagerConfig = {
      operateWrapper: this.operateWrapper,
      ...options,
    };

    const manager = await OlasServiceManager.createDefault(finalOptions);
    
    // Clean up any corrupt services on initialization
    stakingLogger.info("Checking for corrupt service configs to clean up");
    try {
      const cleanupResult = await manager.cleanupCorruptServices();
      
      if (cleanupResult.cleaned.length > 0) {
        stakingLogger.info({ 
          count: cleanupResult.cleaned.length, 
          services: cleanupResult.cleaned 
        }, "Cleaned up corrupt services");
      }
      
      if (cleanupResult.errors.length > 0) {
        stakingLogger.warn({ 
          errors: cleanupResult.errors 
        }, "Some services could not be cleaned up");
      }
    } catch (error) {
      stakingLogger.warn({ error }, "Failed to clean up corrupt services, continuing anyway");
    }
    
    this.serviceManager = manager;
    return manager;
  }

  /**
   * Deploy and stake OLAS service using operate quickstart, then deploy mech
   *
   * This method uses the new OlasServiceManager to deploy and stake services
   * through the operate CLI, then deploys a mech contract for marketplace participation.
   */
  async stakeOlas(): Promise<void> {
    stakingLogger.info("Executing OLAS service deployment, staking, and mech deployment");

    try {
      const manager = await this.ensureServiceManager();
      
      // Step 1: Deploy and stake the service
      const stakingResult = await manager.deployAndStakeService();

      stakingLogger.info({
        serviceName: stakingResult.serviceName,
        isRunning: stakingResult.isRunning,
        isStaked: stakingResult.isStaked,
      }, "OLAS service deployment and staking completed successfully");

      // Step 2: Deploy mech contract for marketplace participation
      if (stakingResult.isStaked) {
        stakingLogger.info("Service successfully staked, proceeding with mech deployment");
        
        try {
          const mechResult = await manager.deployMech();
          
          stakingLogger.info({
            serviceName: mechResult.serviceName,
            mechAddress: mechResult.mechAddress,
            agentId: mechResult.agentId,
          }, "Mech deployment completed successfully");

        } catch (mechError) {
          stakingLogger.error({ error: mechError }, "Failed to deploy mech contract - service remains staked");
          // Don't throw here as the service staking succeeded - mech deployment is additional functionality
          // The service can still participate in OLAS rewards even without a mech
        }
      } else {
        stakingLogger.warn("Service staking not confirmed, skipping mech deployment");
      }

    } catch (error) {
      stakingLogger.error({ error }, "Failed to deploy and stake OLAS service");
      throw error;
    }
  }

  /**
   * Claim staking rewards using operate claim command
   *
   * This method uses the new OlasServiceManager to claim rewards
   * through the operate CLI rather than direct contract interactions.
   */
  async claimIncentives(): Promise<void> {
    stakingLogger.info("Executing staking rewards claiming operation");

    try {
      const manager = await this.ensureServiceManager();
      const result = await manager.claimRewards();

      stakingLogger.info({
        serviceName: result.serviceName,
        isRunning: result.isRunning,
        isStaked: result.isStaked,
      }, "Staking rewards claiming completed successfully");
    } catch (error) {
      stakingLogger.error({ error }, "Failed to claim staking rewards");
      throw error;
    }
  }
}
