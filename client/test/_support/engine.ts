import {
  TaskEngine,
  NotImplementedError,
  type TaskEngineOptions,
} from '@/harnesses/engine/engine.js';
import {
  TaskRunPersistence,
  type PersistedTaskRun,
  type PersistedTaskRunInput,
} from '@/harnesses/engine/persistence.js';
import { TaskRunState } from '@/harnesses/engine/state.js';
import type { Store } from '@/store/store.js';

import { randomBytes } from 'node:crypto';

function nextId(): string { return `req-${randomBytes(4).toString('hex')}`; }

/**
 * Canonical fixture replacing the ~5 ad-hoc `makeInput` helpers across engine tests.
 * Signature drift (`makeInput(overrides)` vs `makeInput(id, overrides)` vs
 * `makeInput(id='req-gate')`) is collapsed into one shape.
 */
export function makeIntentInput(
  overrides: Partial<PersistedTaskRunInput> = {},
): PersistedTaskRunInput {
  const id = overrides.requestId ?? nextId();
  const now = Date.now();
  return {
    requestId: id,
    taskCid: `bafycid-${id}`,
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 1000,
    solverType: 'portfolio.v0',
    windowStartTs: now + 60_000,
    windowEndTs: now + 60_000 + 86_400_000,
    task: { id, description: 'test', solverType: 'portfolio.v0', role: 'restoration' },
    ...overrides,
  };
}

/**
 * A thin subclass of TaskRunPersistence that overrides `insertDiscovered` to
 * return the newly-inserted PersistedTaskRun (the base class returns void).
 * This makes test assertions on the inserted row ergonomic without calling
 * `getOrThrow` separately.
 */
class TestPersistence extends TaskRunPersistence {
  insertDiscovered(input: PersistedTaskRunInput): PersistedTaskRun {
    super.insertDiscovered(input);
    return this.getOrThrow(input.requestId);
  }
}

export interface StateMachineSpyOpts {
  store: Store;
  paths?: { workingDirRoot: string; implStateDirRoot: string };
  /** When provided, the real claim() implementation is used (via super.claim()). */
  claimDeps?: TaskEngineOptions['claimDeps'];
  /** When provided, wires the impl registry for claim-gate tests. */
  implRegistry?: TaskEngineOptions['implRegistry'];
  /**
   * When provided, the real pack() implementation is used (via super.pack()).
   * Also enables the real takePreSnapshot() (which has no external deps).
   */
  packagingDeps?: TaskEngineOptions['packagingDeps'];
  manifestDeps?: TaskEngineOptions['manifestDeps'];
  /** When provided, the real deliver() implementation is used (via super.deliver()). */
  deliveryDeps?: TaskEngineOptions['deliveryDeps'];
  onClaim?(intent: PersistedTaskRun): Promise<void>;
  onPreSnapshot?(intent: PersistedTaskRun): Promise<void>;
  onRunImpl?(intent: PersistedTaskRun): Promise<void>;
  onPostSnapshot?(intent: PersistedTaskRun): Promise<void>;
  onPack?(intent: PersistedTaskRun): Promise<void>;
  onDeliver?(intent: PersistedTaskRun): Promise<void>;
}

export interface StateMachineSpy {
  engine: SpyEngine;
  calls: string[];
  callsByIntent: Map<string, string[]>;
}

export class SpyEngine extends TaskEngine {
  readonly calls: string[] = [];
  readonly callsByIntent: Map<string, string[]> = new Map();
  private readonly spyOpts: StateMachineSpyOpts;

  // Typed accessor that exposes the TestPersistence subclass
  readonly testPersistence: TestPersistence;

  constructor(opts: StateMachineSpyOpts) {
    // We need store.db for TestPersistence, so build opts first then pass to super.
    // The base class constructs TaskRunPersistence from opts.store.db; we shadow it.
    super({
      store: opts.store,
      paths: opts.paths ?? { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
      claimDeps: opts.claimDeps,
      implRegistry: opts.implRegistry,
      packagingDeps: opts.packagingDeps,
      manifestDeps: opts.manifestDeps,
      deliveryDeps: opts.deliveryDeps,
    });
    this.spyOpts = opts;
    // Replace the protected persistence with our TestPersistence subclass so
    // insertDiscovered returns the row. We cast through unknown to write to the
    // protected field from outside the class body. This is intentional test
    // infrastructure — it avoids modifying production source files.
    const tp = new TestPersistence(opts.store.db);
    (this as unknown as { persistence: TestPersistence }).persistence = tp;
    this.testPersistence = tp;
  }

  private record(intent: PersistedTaskRun, name: string): void {
    this.calls.push(name);
    const list = this.callsByIntent.get(intent.requestId) ?? [];
    list.push(name);
    this.callsByIntent.set(intent.requestId, list);
  }

  override async claim(intent: PersistedTaskRun): Promise<void> {
    this.record(intent, 'claim');
    if (this.spyOpts.onClaim) return this.spyOpts.onClaim(intent);
    // When claimDeps is injected, delegate to the real implementation.
    if (this.claimDeps) return super.claim(intent);
    throw new NotImplementedError('claim');
  }

  /**
   * Exposes the private dataDrivenAdvance method for unit testing the data-driven
   * advance logic in isolation.
   */
  testDataDrivenAdvance(intent: PersistedTaskRun): TaskRunState | null {
    return (this as unknown as { dataDrivenAdvance(i: PersistedTaskRun): TaskRunState | null }).dataDrivenAdvance(intent);
  }
  override async takePreSnapshot(intent: PersistedTaskRun): Promise<void> {
    this.record(intent, 'takePreSnapshot');
    if (this.spyOpts.onPreSnapshot) return this.spyOpts.onPreSnapshot(intent);
    // takePreSnapshot has no external deps — always delegate to real impl when paths
    // are configured (i.e. when packaging-style opts are injected).
    if (this.spyOpts.packagingDeps !== undefined || this.spyOpts.manifestDeps !== undefined || this.spyOpts.deliveryDeps !== undefined) {
      return super.takePreSnapshot(intent);
    }
    throw new NotImplementedError('takePreSnapshot');
  }
  override async runImpl(intent: PersistedTaskRun): Promise<void> {
    this.record(intent, 'runImpl');
    if (this.spyOpts.onRunImpl) return this.spyOpts.onRunImpl(intent);
    throw new NotImplementedError('runImpl');
  }
  override async takePostSnapshot(intent: PersistedTaskRun): Promise<void> {
    this.record(intent, 'takePostSnapshot');
    if (this.spyOpts.onPostSnapshot) return this.spyOpts.onPostSnapshot(intent);
    throw new NotImplementedError('takePostSnapshot');
  }
  override async pack(intent: PersistedTaskRun): Promise<void> {
    this.record(intent, 'pack');
    if (this.spyOpts.onPack) return this.spyOpts.onPack(intent);
    // When packagingDeps/manifestDeps are injected, delegate to the real implementation.
    if (this.spyOpts.packagingDeps !== undefined || this.spyOpts.manifestDeps !== undefined) {
      return super.pack(intent);
    }
    throw new NotImplementedError('pack');
  }
  override async deliver(intent: PersistedTaskRun): Promise<void> {
    this.record(intent, 'deliver');
    if (this.spyOpts.onDeliver) return this.spyOpts.onDeliver(intent);
    // When deliveryDeps are injected, delegate to the real implementation.
    if (this.spyOpts.deliveryDeps !== undefined) {
      return super.deliver(intent);
    }
    throw new NotImplementedError('deliver');
  }
}

/** Canonical spy engine replacing the ad-hoc TestEngine/SpyEngine subclasses in 5 test files. */
export function createStateMachineSpy(opts: StateMachineSpyOpts): StateMachineSpy {
  const engine = new SpyEngine(opts);
  return { engine, calls: engine.calls, callsByIntent: engine.callsByIntent };
}
