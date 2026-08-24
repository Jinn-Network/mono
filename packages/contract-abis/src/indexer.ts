import { exportSlice } from "./slices.js";
import indexerJinnRouter from "../generated/slices/indexerJinnRouter.json" with { type: "json" };
import indexerTaskCoordinator from "../generated/slices/indexerTaskCoordinator.json" with { type: "json" };
import indexerExternalStakingDistributor from "../generated/slices/indexerExternalStakingDistributor.json" with { type: "json" };
import indexerStolasStakingProxy from "../generated/slices/indexerStolasStakingProxy.json" with { type: "json" };

export const JINN_ROUTER_ABI = exportSlice(indexerJinnRouter);
export const TASK_COORDINATOR_ABI = exportSlice(indexerTaskCoordinator);
export const EXTERNAL_STAKING_DISTRIBUTOR_ABI = exportSlice(indexerExternalStakingDistributor);
export const STOLAS_STAKING_PROXY_ABI = exportSlice(indexerStolasStakingProxy);
