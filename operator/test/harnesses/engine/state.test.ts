import { describe, it, expect } from 'vitest';
import {
  TaskRunState,
  isValidTransition,
  assertValidTransition,
  TERMINAL_STATES,
  IN_FLIGHT_STATES,
  ALL_STATES,
} from '../../../src/harnesses/engine/state.js';

describe('state machine', () => {
  describe('isValidTransition', () => {
    it('allows the happy-path forward chain', () => {
      const chain: TaskRunState[] = [
        TaskRunState.DISCOVERED,
        TaskRunState.CLAIMED,
        TaskRunState.WAITING,
        TaskRunState.PRE_SNAPSHOT,
        TaskRunState.RUNNING,
        TaskRunState.POST_SNAPSHOT,
        TaskRunState.PACKAGING,
        TaskRunState.DELIVERING,
        TaskRunState.AWAITING_ADOPTION,
        TaskRunState.CLAIMING_DELIVERY,
        TaskRunState.COMPLETE,
      ];
      for (let i = 0; i < chain.length - 1; i++) {
        expect(isValidTransition(chain[i], chain[i + 1])).toBe(true);
      }
    });

    it('allows any non-terminal state to transition to FAILED', () => {
      for (const state of IN_FLIGHT_STATES) {
        expect(isValidTransition(state, TaskRunState.FAILED)).toBe(true);
      }
    });

    it('allows any non-terminal state to transition to RACE_LOST', () => {
      for (const state of IN_FLIGHT_STATES) {
        expect(isValidTransition(state, TaskRunState.RACE_LOST)).toBe(true);
      }
    });

    it('does not allow COMPLETE to transition to anything', () => {
      for (const target of ALL_STATES) {
        expect(isValidTransition(TaskRunState.COMPLETE, target)).toBe(false);
      }
    });

    it('does not allow FAILED to transition to anything', () => {
      for (const target of ALL_STATES) {
        expect(isValidTransition(TaskRunState.FAILED, target)).toBe(false);
      }
    });

    it('does not allow RACE_LOST to transition to anything', () => {
      for (const target of ALL_STATES) {
        expect(isValidTransition(TaskRunState.RACE_LOST, target)).toBe(false);
      }
    });

    it('does not allow skipping states (DISCOVERED → RUNNING)', () => {
      expect(isValidTransition(TaskRunState.DISCOVERED, TaskRunState.RUNNING)).toBe(false);
    });

    it('does not allow backwards transitions', () => {
      expect(isValidTransition(TaskRunState.RUNNING, TaskRunState.CLAIMED)).toBe(false);
      expect(isValidTransition(TaskRunState.PACKAGING, TaskRunState.WAITING)).toBe(false);
    });

    it('does not allow staying in the same state (self-transition)', () => {
      for (const state of ALL_STATES) {
        expect(isValidTransition(state, state)).toBe(false);
      }
    });
  });

  describe('assertValidTransition', () => {
    it('does not throw for valid transitions', () => {
      expect(() => assertValidTransition(TaskRunState.DISCOVERED, TaskRunState.CLAIMED)).not.toThrow();
      expect(() => assertValidTransition(TaskRunState.RUNNING, TaskRunState.FAILED)).not.toThrow();
    });

    it('throws for invalid transitions with a descriptive message', () => {
      expect(() => assertValidTransition(TaskRunState.COMPLETE, TaskRunState.RUNNING))
        .toThrow(/Invalid state transition: COMPLETE → RUNNING/);
    });

    it('includes allowed states in the error message', () => {
      expect(() => assertValidTransition(TaskRunState.DISCOVERED, TaskRunState.RUNNING))
        .toThrow(/DISCOVERED/);
    });
  });

  describe('TERMINAL_STATES', () => {
    it('contains COMPLETE, FAILED, and RACE_LOST', () => {
      expect(TERMINAL_STATES.has(TaskRunState.COMPLETE)).toBe(true);
      expect(TERMINAL_STATES.has(TaskRunState.FAILED)).toBe(true);
      expect(TERMINAL_STATES.has(TaskRunState.RACE_LOST)).toBe(true);
      expect(TERMINAL_STATES.size).toBe(3);
    });
  });

  describe('IN_FLIGHT_STATES', () => {
    it('contains all non-terminal states', () => {
      expect(IN_FLIGHT_STATES.has(TaskRunState.DISCOVERED)).toBe(true);
      expect(IN_FLIGHT_STATES.has(TaskRunState.DELIVERING)).toBe(true);
      expect(IN_FLIGHT_STATES.has(TaskRunState.AWAITING_ADOPTION)).toBe(true);
      expect(IN_FLIGHT_STATES.has(TaskRunState.CLAIMING_DELIVERY)).toBe(true);
      expect(IN_FLIGHT_STATES.has(TaskRunState.COMPLETE)).toBe(false);
      expect(IN_FLIGHT_STATES.has(TaskRunState.FAILED)).toBe(false);
      expect(IN_FLIGHT_STATES.has(TaskRunState.RACE_LOST)).toBe(false);
      expect(IN_FLIGHT_STATES.size).toBe(10);
    });
  });

  describe('ALL_STATES', () => {
    it('has 13 states total', () => {
      expect(ALL_STATES).toHaveLength(13);
    });
  });
});
