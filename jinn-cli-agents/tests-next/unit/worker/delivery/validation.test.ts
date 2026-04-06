/**
 * Unit Test: Delivery Validation
 * Module: worker/delivery/validation.ts
 * Priority: P0 (CRITICAL)
 *
 * Tests validateDeliveryContext() function that validates delivery contexts
 * before submission. Prevents invalid deliveries from being submitted on-chain.
 */
import { describe, it, expect } from 'vitest';
import { validateDeliveryContext } from 'jinn-node/worker/delivery/validation.js';
import type { DeliveryValidationContext } from 'jinn-node/worker/delivery/validation.js';
import type { UnclaimedRequest, AgentExecutionResult, FinalStatus, IpfsMetadata } from 'jinn-node/worker/types.js';

describe('validateDeliveryContext', () => {
  const validRequest: UnclaimedRequest = {
    id: '0x1234',
    sender: '0xsender',
    data: '0xdata',
    blockTimestamp: '1234567890',
  };

  const validResult: AgentExecutionResult = {
    output: 'Task completed',
    telemetry: { duration: 1000, totalTokens: 500 },
  };

  const validFinalStatus: FinalStatus = {
    status: 'COMPLETED',
    reason: 'All tasks done',
  };

  const validMetadata: IpfsMetadata = {
    prompt: 'Do the thing',
    enabledTools: ['read_file', 'write_file'],
  };

  describe('valid delivery contexts', () => {
    it('accepts valid context with all required fields', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });

    it('accepts COMPLETED status', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: { status: 'COMPLETED' },
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(true);
    });

    it('accepts DELEGATING status', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: { status: 'DELEGATING' },
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(true);
    });

    it('accepts WAITING status', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: { status: 'WAITING' },
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(true);
    });

    it('accepts FAILED status', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: { status: 'FAILED', reason: 'Error occurred' },
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(true);
    });

    it('accepts empty string output', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: {
          output: '',
          telemetry: {},
        },
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(true);
    });

    it('accepts empty telemetry object', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: {
          output: 'Done',
          telemetry: {},
        },
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(true);
    });

    it('accepts empty metadata object', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: validFinalStatus,
        metadata: {},
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(true);
    });
  });

  describe('invalid requestId', () => {
    it('rejects missing requestId', () => {
      const context = {
        requestId: '',
        request: validRequest,
        result: validResult,
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing requestId');
    });

    it('rejects null requestId', () => {
      const context = {
        requestId: null as any,
        request: validRequest,
        result: validResult,
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing requestId');
    });

    it('rejects undefined requestId', () => {
      const context = {
        request: validRequest,
        result: validResult,
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      } as any;

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing requestId');
    });
  });

  describe('invalid result', () => {
    it('rejects missing result', () => {
      const context = {
        requestId: '0x1234',
        request: validRequest,
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      } as any;

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing result');
    });

    it('rejects null result', () => {
      const context = {
        requestId: '0x1234',
        request: validRequest,
        result: null as any,
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing result');
    });

    it('rejects result with non-string output', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: {
          output: 123 as any,
          telemetry: {},
        },
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Result output must be a string');
    });

    it('rejects result with array output', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: {
          output: ['item1', 'item2'] as any,
          telemetry: {},
        },
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Result output must be a string');
    });

    it('rejects result with missing telemetry', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: {
          output: 'Done',
        } as any,
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Result telemetry must be an object');
    });

    it('rejects result with null telemetry', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: {
          output: 'Done',
          telemetry: null as any,
        },
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Result telemetry must be an object');
    });

    it('rejects result with string telemetry', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: {
          output: 'Done',
          telemetry: 'invalid' as any,
        },
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Result telemetry must be an object');
    });

    it('accepts array telemetry (arrays are objects in JS)', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: {
          output: 'Done',
          telemetry: [] as any,
        },
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      // Arrays pass typeof check (typeof [] === 'object')
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });
  });

  describe('invalid finalStatus', () => {
    it('rejects missing finalStatus', () => {
      const context = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        metadata: validMetadata,
      } as any;

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing finalStatus');
    });

    it('rejects null finalStatus', () => {
      const context = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: null as any,
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing finalStatus');
    });

    it('rejects invalid status value', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: {
          status: 'INVALID_STATUS' as any,
        },
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Invalid finalStatus: INVALID_STATUS');
    });

    it('rejects lowercase status', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: {
          status: 'completed' as any,
        },
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Invalid finalStatus: completed');
    });

    it('rejects empty string status', () => {
      const context: DeliveryValidationContext = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: {
          status: '' as any,
        },
        metadata: validMetadata,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Invalid finalStatus: ');
    });
  });

  describe('invalid metadata', () => {
    it('rejects missing metadata', () => {
      const context = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: validFinalStatus,
      } as any;

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing metadata');
    });

    it('rejects null metadata', () => {
      const context = {
        requestId: '0x1234',
        request: validRequest,
        result: validResult,
        finalStatus: validFinalStatus,
        metadata: null as any,
      };

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing metadata');
    });
  });

  describe('multiple validation errors', () => {
    it('collects all validation errors', () => {
      const context = {
        requestId: '',
        request: validRequest,
        result: {
          output: 123,
          telemetry: null,
        },
        finalStatus: {
          status: 'INVALID',
        },
        metadata: null,
      } as any;

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(5);
      expect(validation.errors).toContain('Missing requestId');
      expect(validation.errors).toContain('Result output must be a string');
      expect(validation.errors).toContain('Result telemetry must be an object');
      expect(validation.errors).toContain('Invalid finalStatus: INVALID');
      expect(validation.errors).toContain('Missing metadata');
    });

    it('reports result validation errors when result is present but invalid', () => {
      const context = {
        requestId: '0x1234',
        request: validRequest,
        result: {
          output: null,
          telemetry: 'not an object',
        },
        finalStatus: validFinalStatus,
        metadata: validMetadata,
      } as any;

      const validation = validateDeliveryContext(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(2);
      expect(validation.errors).toContain('Result output must be a string');
      expect(validation.errors).toContain('Result telemetry must be an object');
    });
  });
});
