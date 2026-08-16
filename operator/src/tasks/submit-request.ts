import {
  TaskSubmitRequestV1Schema,
  parseTaskSubmitRequestV1,
  type TaskSubmitRequestV1,
} from '@jinn-network/sdk/autopilot';

export const MarketplaceTaskSubmitRequestSchema = TaskSubmitRequestV1Schema;
export type MarketplaceTaskSubmitRequest = TaskSubmitRequestV1;
export const parseMarketplaceTaskSubmitRequest = parseTaskSubmitRequestV1;
