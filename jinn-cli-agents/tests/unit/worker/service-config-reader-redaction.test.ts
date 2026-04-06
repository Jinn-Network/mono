import { describe, expect, it } from 'vitest';
import { redactServiceInfoForLog, type ServiceInfo } from 'jinn-node/worker/ServiceConfigReader.js';

describe('redactServiceInfoForLog', () => {
  it('removes agentPrivateKey and exposes hasAgentPrivateKey=true when key exists', () => {
    const serviceInfo: ServiceInfo = {
      serviceConfigId: 'sc-123',
      serviceName: 'jinn-service',
      chain: 'base',
      serviceSafeAddress: '0x1111111111111111111111111111111111111111',
      agentEoaAddress: '0x2222222222222222222222222222222222222222',
      mechContractAddress: '0x3333333333333333333333333333333333333333',
      serviceId: 123,
      stakingContractAddress: '0x4444444444444444444444444444444444444444',
      agentPrivateKey: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    const redacted = redactServiceInfoForLog(serviceInfo);

    expect(redacted).not.toHaveProperty('agentPrivateKey');
    expect(redacted.hasAgentPrivateKey).toBe(true);
    expect(redacted.serviceConfigId).toBe('sc-123');
  });

  it('sets hasAgentPrivateKey=false when key is absent', () => {
    const serviceInfo: ServiceInfo = {
      serviceConfigId: 'sc-456',
      serviceName: 'jinn-service-2',
      chain: 'base',
    };

    const redacted = redactServiceInfoForLog(serviceInfo);

    expect(redacted).not.toHaveProperty('agentPrivateKey');
    expect(redacted.hasAgentPrivateKey).toBe(false);
  });
});
