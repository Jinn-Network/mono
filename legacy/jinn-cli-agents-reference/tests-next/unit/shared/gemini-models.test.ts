import { describe, it, expect } from 'vitest';
import { normalizeGeminiModel } from 'jinn-node/shared/gemini-models.js';

describe('normalizeGeminiModel', () => {
    it('uses default when input is empty', () => {
        const result = normalizeGeminiModel('', 'auto-gemini-3');
        expect(result.normalized).toBe('auto-gemini-3');
        expect(result.changed).toBe(false);
    });

    it('strips models/ prefix', () => {
        const result = normalizeGeminiModel('models/gemini-2.5-flash', 'auto-gemini-3');
        expect(result.normalized).toBe('gemini-2.5-flash');
        expect(result.changed).toBe(true);
    });

    it('upgrades gemini-3-pro to preview variant', () => {
        const result = normalizeGeminiModel('gemini-3-pro', 'auto-gemini-3');
        expect(result.normalized).toBe('gemini-3-pro-preview');
        expect(result.changed).toBe(true);
    });

    it('upgrades gemini-3-flash to preview variant', () => {
        const result = normalizeGeminiModel('gemini-3-flash', 'auto-gemini-3');
        expect(result.normalized).toBe('gemini-3-flash-preview');
        expect(result.changed).toBe(true);
    });

    it('leaves valid model untouched', () => {
        const result = normalizeGeminiModel('gemini-2.5-pro', 'auto-gemini-3');
        expect(result.normalized).toBe('gemini-2.5-pro');
        expect(result.changed).toBe(false);
    });
});

