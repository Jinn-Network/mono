import { describe, it, expect } from 'vitest';
import {
  checkTracedHttpBoundary,
  checkMcpShimBoundary,
  checkSubprocessBoundary,
  checkRawSockets,
  checkDynamicCode,
  checkArtifactEmitPath,
} from '../../../src/conformance/checks/source-static.js';
import {
  GOOD_LLM_BUNDLE,
  BAD_RAW_FETCH_BUNDLE,
  BAD_AXIOS_BUNDLE,
  GOOD_MCP_BUNDLE,
  BAD_RAW_MCP_BUNDLE,
  GOOD_SUBPROCESS_BUNDLE,
  BAD_RAW_SPAWN_BUNDLE,
  BAD_EXECA_BUNDLE,
  BAD_RAW_SOCKET_BUNDLE,
  BAD_TLS_CONNECT_BUNDLE,
  BAD_EVAL_BUNDLE,
  BAD_NEW_FUNCTION_BUNDLE,
  BAD_DYNAMIC_IMPORT_BUNDLE,
  BAD_VM_BUNDLE,
  GOOD_DYNAMIC_BUNDLE,
  GOOD_ARTIFACT_BUNDLE,
  BAD_RAW_WRITE_FILE_BUNDLE,
} from '../fixtures/source-bundles/index.js';

// ─── Task 10: traced HTTP boundary ───────────────────────────────────────────

describe('checkTracedHttpBoundary', () => {
  it('passes on a bundle where all LLM calls route through the wrapper', () => {
    const result = checkTracedHttpBoundary({ sourceBundle: GOOD_LLM_BUNDLE } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('source.traced-http');
    expect(result.layer).toBe(2);
  });

  it('fails on raw fetch to api.anthropic.com', () => {
    const result = checkTracedHttpBoundary({ sourceBundle: BAD_RAW_FETCH_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/api\.anthropic\.com/);
  });

  it('fails on axios call to api.openai.com', () => {
    const result = checkTracedHttpBoundary({ sourceBundle: BAD_AXIOS_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/api\.openai\.com/);
  });

  it('skipped when no sourceBundle present', () => {
    const result = checkTracedHttpBoundary({} as any);
    expect(result.skipped).toBe(true);
    expect(result.layer).toBe(2);
  });

  it('skipped when sourceBundle is undefined', () => {
    const result = checkTracedHttpBoundary({ sourceBundle: undefined } as any);
    expect(result.skipped).toBe(true);
  });
});

// ─── Task 11: MCP shim boundary ──────────────────────────────────────────────

describe('checkMcpShimBoundary', () => {
  it('passes on bundle routing MCP calls through wrapper', () => {
    const result = checkMcpShimBoundary({ sourceBundle: GOOD_MCP_BUNDLE } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('source.mcp-shim');
    expect(result.layer).toBe(2);
  });

  it('fails on raw MCP client construction outside wrapper', () => {
    const result = checkMcpShimBoundary({ sourceBundle: BAD_RAW_MCP_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it('skipped when no sourceBundle present', () => {
    const result = checkMcpShimBoundary({} as any);
    expect(result.skipped).toBe(true);
    expect(result.layer).toBe(2);
  });
});

// ─── Task 11: subprocess boundary ────────────────────────────────────────────

describe('checkSubprocessBoundary', () => {
  it('passes when subprocess imports confined to wrapper', () => {
    const result = checkSubprocessBoundary({ sourceBundle: GOOD_SUBPROCESS_BUNDLE } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('source.subprocess');
    expect(result.layer).toBe(2);
  });

  it('fails on raw child_process import outside wrapper', () => {
    const result = checkSubprocessBoundary({ sourceBundle: BAD_RAW_SPAWN_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it('fails on execa import outside wrapper', () => {
    const result = checkSubprocessBoundary({ sourceBundle: BAD_EXECA_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/execa/);
  });

  it('skipped when no sourceBundle present', () => {
    const result = checkSubprocessBoundary({} as any);
    expect(result.skipped).toBe(true);
    expect(result.layer).toBe(2);
  });
});

// ─── Task 12: raw sockets ─────────────────────────────────────────────────────

describe('checkRawSockets', () => {
  it('fails on raw net import outside wrapper', () => {
    const result = checkRawSockets({ sourceBundle: BAD_RAW_SOCKET_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('source.raw-sockets');
    expect(result.layer).toBe(2);
    expect(result.detail).toBeTruthy();
  });

  it('fails on raw tls import outside wrapper', () => {
    const result = checkRawSockets({ sourceBundle: BAD_TLS_CONNECT_BUNDLE } as any);
    expect(result.passed).toBe(false);
  });

  it('passes on a clean bundle with no raw socket usage', () => {
    const result = checkRawSockets({ sourceBundle: GOOD_LLM_BUNDLE } as any);
    expect(result.passed).toBe(true);
  });

  it('skipped when no sourceBundle present', () => {
    const result = checkRawSockets({} as any);
    expect(result.skipped).toBe(true);
    expect(result.layer).toBe(2);
  });
});

// ─── Task 12: dynamic code loading ───────────────────────────────────────────

describe('checkDynamicCode', () => {
  it('fails on eval usage', () => {
    const result = checkDynamicCode({ sourceBundle: BAD_EVAL_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('source.dynamic-code');
    expect(result.layer).toBe(2);
    expect(result.detail).toMatch(/eval/);
  });

  it('fails on new Function usage', () => {
    const result = checkDynamicCode({ sourceBundle: BAD_NEW_FUNCTION_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/new Function/);
  });

  it('fails on dynamic import with non-literal argument', () => {
    const result = checkDynamicCode({ sourceBundle: BAD_DYNAMIC_IMPORT_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/dynamic import/);
  });

  it('fails on vm.runIn* usage', () => {
    const result = checkDynamicCode({ sourceBundle: BAD_VM_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/vm\.runIn/);
  });

  it('passes on statically analyzable relative-path dynamic imports', () => {
    const result = checkDynamicCode({ sourceBundle: GOOD_DYNAMIC_BUNDLE } as any);
    expect(result.passed).toBe(true);
  });

  it('skipped when no sourceBundle present', () => {
    const result = checkDynamicCode({} as any);
    expect(result.skipped).toBe(true);
    expect(result.layer).toBe(2);
  });
});

// ─── Task 13: artifact emit helper ───────────────────────────────────────────

describe('checkArtifactEmitPath', () => {
  it('passes when all artifact emission goes through the canonical helper', () => {
    const result = checkArtifactEmitPath({ sourceBundle: GOOD_ARTIFACT_BUNDLE } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('source.artifact-emit');
    expect(result.layer).toBe(2);
  });

  it('fails when a non-helper file writes fs + calls uploadToIpfs', () => {
    const result = checkArtifactEmitPath({ sourceBundle: BAD_RAW_WRITE_FILE_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it('passes on a bundle with no fs writes at all (LLM bundle)', () => {
    const result = checkArtifactEmitPath({ sourceBundle: GOOD_LLM_BUNDLE } as any);
    expect(result.passed).toBe(true);
  });

  it('skipped when no sourceBundle present', () => {
    const result = checkArtifactEmitPath({} as any);
    expect(result.skipped).toBe(true);
    expect(result.layer).toBe(2);
  });
});
