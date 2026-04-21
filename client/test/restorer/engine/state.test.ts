import { describe, it, expect } from 'vitest';
import {
  IntentState,
  isValidTransition,
  assertValidTransition,
  TERMINAL_STATES,
  IN_FLIGHT_STATES,
  ALL_STATES,
} from '../../../src/restorer/engine/state.js';

describe('state machine', () => {
  describe('isValidTransition', () => {
    it('allows the happy-path forward chain', () => {
      const chain: IntentState[] = [
        IntentState.DISCOVERED,
        IntentState.CLAIMED,
        IntentState.WAITING,
        IntentState.PRE_SNAPSHOT,
        IntentState.RUNNING,
        IntentState.POST_SNAPSHOT,
        IntentState.PACKAGING,
        IntentState.DELIVERING,
        IntentState.COMPLETE,
      ];
      for (let i = 0; i < chain.length - 1; i++) {
        expect(isValidTransition(chain[i], chain[i + 1])).toBe(true);
      }
    });

    it('allows any non-terminal state to transition to FAILED', () => {
      for (const state of IN_FLIGHT_STATES) {
        expect(isValidTransition(state, IntentState.FAILED)).toBe(true);
      }
    });

    it('does not allow COMPLETE to transition to anything', () => {
      for (const target of ALL_STATES) {
        expect(isValidTransition(IntentState.COMPLETE, target)).toBe(false);
      }
    });

    it('does not allow FAILED to transition to anything', () => {
      for (const target of ALL_STATES) {
        expect(isValidTransition(IntentState.FAILED, target)).toBe(false);
      }
    });

    it('does not allow skipping states (DISCOVERED → RUNNING)', () => {
      expect(isValidTransition(IntentState.DISCOVERED, IntentState.RUNNING)).toBe(false);
    });

    it('does not allow backwards transitions', () => {
      expect(isValidTransition(IntentState.RUNNING, IntentState.CLAIMED)).toBe(false);
      expect(isValidTransition(IntentState.PACKAGING, IntentState.WAITING)).toBe(false);
    });

    it('does not allow staying in the same state (self-transition)', () => {
      for (const state of ALL_STATES) {
        expect(isValidTransition(state, state)).toBe(false);
      }
    });
  });

  describe('assertValidTransition', () => {
    it('does not throw for valid transitions', () => {
      expect(() => assertValidTransition(IntentState.DISCOVERED, IntentState.CLAIMED)).not.toThrow();
      expect(() => assertValidTransition(IntentState.RUNNING, IntentState.FAILED)).not.toThrow();
    });

    it('throws for invalid transitions with a descriptive message', () => {
      expect(() => assertValidTransition(IntentState.COMPLETE, IntentState.RUNNING))
        .toThrow(/Invalid state transition: COMPLETE → RUNNING/);
    });

    it('includes allowed states in the error message', () => {
      expect(() => assertValidTransition(IntentState.DISCOVERED, IntentState.RUNNING))
        .toThrow(/DISCOVERED/);
    });
  });

  describe('TERMINAL_STATES', () => {
    it('contains COMPLETE and FAILED', () => {
      expect(TERMINAL_STATES.has(IntentState.COMPLETE)).toBe(true);
      expect(TERMINAL_STATES.has(IntentState.FAILED)).toBe(true);
      expect(TERMINAL_STATES.size).toBe(2);
    });
  });

  describe('IN_FLIGHT_STATES', () => {
    it('contains all non-terminal states', () => {
      expect(IN_FLIGHT_STATES.has(IntentState.DISCOVERED)).toBe(true);
      expect(IN_FLIGHT_STATES.has(IntentState.DELIVERING)).toBe(true);
      expect(IN_FLIGHT_STATES.has(IntentState.COMPLETE)).toBe(false);
      expect(IN_FLIGHT_STATES.has(IntentState.FAILED)).toBe(false);
      expect(IN_FLIGHT_STATES.size).toBe(8);
    });
  });

  describe('ALL_STATES', () => {
    it('has 10 states total', () => {
      expect(ALL_STATES).toHaveLength(10);
    });
  });
});
