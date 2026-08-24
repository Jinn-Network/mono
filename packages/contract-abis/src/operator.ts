import { exportSlice } from "./slices.js";
import operatorJinnRouter from "../generated/slices/operatorJinnRouter.json" with { type: "json" };
import operatorMechMarketplace from "../generated/slices/operatorMechMarketplace.json" with { type: "json" };
import operatorMechMarketplaceDeliver from "../generated/slices/operatorMechMarketplaceDeliver.json" with { type: "json" };
import operatorOlasMech from "../generated/slices/operatorOlasMech.json" with { type: "json" };

export const JINN_ROUTER_ABI = exportSlice(operatorJinnRouter);
export const MECH_MARKETPLACE_ABI = exportSlice(operatorMechMarketplace);
export const MECH_MARKETPLACE_DELIVER_ABI = exportSlice(operatorMechMarketplaceDeliver);
export const MECH_ABI = exportSlice(operatorOlasMech);
