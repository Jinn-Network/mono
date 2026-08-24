import operatorJinnRouter from "../generated/slices/operatorJinnRouter.json" with { type: "json" };
import operatorMechMarketplace from "../generated/slices/operatorMechMarketplace.json" with { type: "json" };
import operatorMechMarketplaceDeliver from "../generated/slices/operatorMechMarketplaceDeliver.json" with { type: "json" };
import operatorOlasMech from "../generated/slices/operatorOlasMech.json" with { type: "json" };

export const JINN_ROUTER_ABI = operatorJinnRouter.items as const;
export const MECH_MARKETPLACE_ABI = operatorMechMarketplace.items as const;
export const MECH_MARKETPLACE_DELIVER_ABI = operatorMechMarketplaceDeliver.items as const;
export const MECH_ABI = operatorOlasMech.items as const;
