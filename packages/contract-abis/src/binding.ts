import { exportSlice } from "./slices.js";
import bindingJinnRouterV3 from "../generated/slices/bindingJinnRouterV3.json" with { type: "json" };
import bindingJinnRouterV4 from "../generated/slices/bindingJinnRouterV4.json" with { type: "json" };
import bindingTaskCoordinator from "../generated/slices/bindingTaskCoordinator.json" with { type: "json" };
import bindingMechMarketplace from "../generated/slices/bindingMechMarketplace.json" with { type: "json" };
import bindingMechDeliverEvent from "../generated/slices/bindingMechDeliverEvent.json" with { type: "json" };
import bindingMechOperator from "../generated/slices/bindingMechOperator.json" with { type: "json" };
import bindingMechDeliverToMarketplace from "../generated/slices/bindingMechDeliverToMarketplace.json" with { type: "json" };

export const JINN_ROUTER_V3_ABI = exportSlice(bindingJinnRouterV3);
export const JINN_ROUTER_V4_ABI = exportSlice(bindingJinnRouterV4);
export const TASK_COORDINATOR_ABI = exportSlice(bindingTaskCoordinator);
export const MECH_MARKETPLACE_ABI = exportSlice(bindingMechMarketplace);
export const MECH_ABI = exportSlice(bindingMechDeliverEvent);
export const MECH_OPERATOR_ABI = exportSlice(bindingMechOperator);
export const MECH_DELIVER_TO_MARKETPLACE_ABI = exportSlice(bindingMechDeliverToMarketplace);
