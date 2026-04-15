/**
 * Factory for creating and initializing OLAS staking manager
 * Refactored for JINN-180: Use OlasOperateWrapper instead of SafeExecutor
 */

import { OlasStakingManager } from "./OlasStakingManager.js";
import { OlasOperateWrapper } from "./OlasOperateWrapper.js";
import { logger } from '../logging/index.js';

const stakingLogger = logger.child({ component: "STAKING-FACTORY" });

export class StakingManagerFactory {
  /**
   * Creates and initializes an OLAS staking manager with proper error handling
   * @returns OlasStakingManager instance or null if initialization fails
   */
  static async createStakingManager(): Promise<OlasStakingManager | null> {
    try {
      // Create OlasOperateWrapper for CLI operations
      const operateWrapper = await OlasOperateWrapper.create();

      // Initialize OlasStakingManager
      const stakingManager = new OlasStakingManager(operateWrapper);
      stakingLogger.info("OLAS staking manager initialized successfully with operate wrapper");

      return stakingManager;
    } catch (error) {
      stakingLogger.warn(
        { error },
        "Failed to initialize OLAS staking manager - staking operations will be disabled",
      );
      return null;
    }
  }
}
