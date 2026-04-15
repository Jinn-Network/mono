import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getJobContext, setJobContext, clearJobContext, snapshotJobContext, restoreJobContext, writeContextToEnv, readContextFromEnv } from 'jinn-node/config/context.js';

describe('jobContext', () => {
    beforeEach(() => clearJobContext());

    afterEach(() => {
        // Clean up process.env from writeContextToEnv tests
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('JINN_CTX_')) delete process.env[key];
        }
    });

    it('returns empty context initially', () => {
        expect(getJobContext().requestId).toBeUndefined();
        expect(getJobContext().mechAddress).toBeUndefined();
    });

    it('sets and gets context values', () => {
        setJobContext({ requestId: '0x123', mechAddress: '0xabc' });
        expect(getJobContext().requestId).toBe('0x123');
        expect(getJobContext().mechAddress).toBe('0xabc');
    });

    it('merges context values', () => {
        setJobContext({ requestId: '0x123' });
        setJobContext({ mechAddress: '0xabc' });
        expect(getJobContext().requestId).toBe('0x123');
        expect(getJobContext().mechAddress).toBe('0xabc');
    });

    it('clearJobContext resets all values', () => {
        setJobContext({ requestId: '0x123' });
        clearJobContext();
        expect(getJobContext().requestId).toBeUndefined();
    });

    it('context is read-only', () => {
        setJobContext({ requestId: '0x123' });
        const ctx = getJobContext();
        expect(() => { (ctx as any).requestId = '0x456'; }).toThrow();
    });

    it('snapshot and restore work correctly', () => {
        setJobContext({ requestId: '0x123', jobName: 'test-job' });
        const snapshot = snapshotJobContext();
        clearJobContext();
        expect(getJobContext().requestId).toBeUndefined();

        restoreJobContext(snapshot);
        expect(getJobContext().requestId).toBe('0x123');
        expect(getJobContext().jobName).toBe('test-job');
    });

    it('writeContextToEnv → readContextFromEnv round-trips string values', () => {
        setJobContext({ requestId: '0xabc', mechAddress: '0xdef' });
        writeContextToEnv();
        clearJobContext();
        const read = readContextFromEnv();
        expect(read.requestId).toBe('0xabc');
        expect(read.mechAddress).toBe('0xdef');
    });

    it('writeContextToEnv → readContextFromEnv round-trips arrays and booleans', () => {
        setJobContext({
            requiredTools: ['dispatch_new_job', 'create_artifact'],
            completedChildRequestIds: ['0x1', '0x2'],
            childWorkReviewed: false,
        });
        writeContextToEnv();
        clearJobContext();
        const read = readContextFromEnv();
        expect(read.requiredTools).toEqual(['dispatch_new_job', 'create_artifact']);
        expect(read.completedChildRequestIds).toEqual(['0x1', '0x2']);
        expect(read.childWorkReviewed).toBe(false);
    });
});
