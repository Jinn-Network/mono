import bindingJinnRouterV3 from "../generated/slices/bindingJinnRouterV3.json" with { type: "json" };
import bindingJinnRouterV4 from "../generated/slices/bindingJinnRouterV4.json" with { type: "json" };
import bindingTaskCoordinator from "../generated/slices/bindingTaskCoordinator.json" with { type: "json" };
import bindingMechMarketplace from "../generated/slices/bindingMechMarketplace.json" with { type: "json" };
import bindingMechDeliverEvent from "../generated/slices/bindingMechDeliverEvent.json" with { type: "json" };
import bindingMechOperator from "../generated/slices/bindingMechOperator.json" with { type: "json" };
import bindingMechDeliverToMarketplace from "../generated/slices/bindingMechDeliverToMarketplace.json" with { type: "json" };

export const JINN_ROUTER_V3_ABI = bindingJinnRouterV3.items as const;
export const JINN_ROUTER_V4_ABI = bindingJinnRouterV4.items as const;
export const TASK_COORDINATOR_ABI = bindingTaskCoordinator.items as const;
export const MECH_MARKETPLACE_ABI = bindingMechMarketplace.items as const;
export const MECH_ABI = bindingMechDeliverEvent.items as const;
export const MECH_OPERATOR_ABI = bindingMechOperator.items as const;
export const MECH_DELIVER_TO_MARKETPLACE_ABI = bindingMechDeliverToMarketplace.items as const;
