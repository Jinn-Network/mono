import { BroadcastUncertainError, type PostingPorts } from "@jinn-network/marketplace-binding";
import { sha256Hex } from "@jinn-network/task-execution-protocol";
import { describe, expect, test, vi } from "vitest";
import {
  executePosting,
  type PostTaskFn,
  type PostingDeps,
  type PostingLogLine,
} from "./execute.js";
import { planPosting } from "./plan.js";
import type { PostingPolicy, PostingPoolEntry } from "./types.js";

const CHAIN = { chainId: 84532, taskCoordinator: "0x01", jinnRouter: "0x02", mechMarketplace: "0x03", activityChecker: "0x04", generation: "today" } as never;

function entry(seed: string): PostingPoolEntry {
  const taskBytes = new TextEncoder().encode(`task-${seed}`);
  return {
    taskDigest: `sha256:${sha256Hex(taskBytes)}`,
    taskBytes,
    evaluationSpecDigest: `sha256:${seed.repeat(64).slice(0, 63)}e`,
    admissionReceiptDigest: `sha256:${seed.repeat(64).slice(0, 63)}a`,
    evaluationSpecPublic: true,
  };
}

const POLICY: PostingPolicy = {
  terms: {
    solutionMaxDeliveryRateWei: 10n, verdictMaxDeliveryRateWei: 2n,
    responseTimeoutSeconds: 3_600n, allowSolverSelfEvaluation: false, maxClaims: 1,
  },
  creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
  requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
  now: "2026-07-31T00:00:00Z",
  deadlineSeconds: 86_400,
  batchLimit: 5,
};

function deps(overrides: Partial<PostingDeps> = {}, pool: readonly PostingPoolEntry[] = []) {
  const lines: PostingLogLine[] = [];
  // Typed with PostTaskFn so `postTask.mock.calls[0]` is the real six-argument tuple: an untyped
  // `vi.fn(async () => ...)` infers a zero-parameter mock and the positional assertions below
  // would not typecheck.
  const postTask = vi.fn<PostTaskFn>(async () => ({ taskId: 1n, txHash: `0x${"ab".repeat(32)}` as const }));
  const base: PostingDeps = {
    entries: new Map(pool.map((item) => [item.taskDigest, item])),
    chain: CHAIN,
    ports: {} as PostingPorts,
    postTask,
    render: { renderPlan: vi.fn() },
    approval: { approvePlan: vi.fn(async () => ({ approved: true as const })) },
    log: { record: (line) => lines.push(line) },
    ...overrides,
  };
  return { deps: base, lines, postTask };
}

describe("executePosting", () => {
  test("surfaces the plan before anything is spent, then posts once approved", async () => {
    const pool = [entry("1")];
    const plan = planPosting(pool, POLICY);
    const { deps: d, postTask } = deps({}, pool);

    const summary = await executePosting(d, plan);

    expect(d.render.renderPlan).toHaveBeenCalledWith(plan);
    expect(d.approval.approvePlan).toHaveBeenCalledTimes(1);
    expect(postTask).toHaveBeenCalledTimes(1);
    expect(summary.posted).toEqual([{ taskDigest: pool[0]!.taskDigest, taskId: 1n, txHash: `0x${"ab".repeat(32)}` }]);
    expect(summary.spentEscrowValueWei).toBe(plan.totalEscrowValueWei);
  });

  test("renders the plan before asking for approval, and asks before posting", async () => {
    const pool = [entry("1")];
    const order: string[] = [];
    const { deps: d } = deps({
      render: { renderPlan: () => { order.push("render"); } },
      approval: { approvePlan: async () => { order.push("approve"); return { approved: true }; } },
      postTask: vi.fn(async () => { order.push("post"); return { taskId: 1n, txHash: `0x${"ab".repeat(32)}` as const }; }),
    }, pool);

    await executePosting(d, planPosting(pool, POLICY));
    expect(order).toEqual(["render", "approve", "post"]);
  });

  test("spends nothing when approval is withheld", async () => {
    const pool = [entry("1")];
    const { deps: d, postTask, lines } = deps({
      approval: { approvePlan: async () => ({ approved: false, reason: "escrow too high today" }) },
    }, pool);

    const summary = await executePosting(d, planPosting(pool, POLICY));

    expect(postTask).not.toHaveBeenCalled();
    expect(summary.refused).toBe("escrow too high today");
    expect(summary.spentEscrowValueWei).toBe(0n);
    expect(lines.map((line) => line.event)).toContain("posting.refused");
  });

  test("auto-post skips the approval call but logs the same terms and escrow", async () => {
    const pool = [entry("1")];
    const explicitRun = deps({}, pool);
    await executePosting(explicitRun.deps, planPosting(pool, POLICY));
    const autoRun = deps({}, pool);
    await executePosting(autoRun.deps, planPosting(pool, { ...POLICY, autoPost: true }));

    expect(autoRun.deps.approval.approvePlan).not.toHaveBeenCalled();
    const explicitFields = explicitRun.lines.find((line) => line.event === "posting.approved")?.fields;
    const autoFields = autoRun.lines.find((line) => line.event === "posting.auto-approved")?.fields;
    expect(autoFields).toEqual(explicitFields);
    expect(autoFields).toMatchObject({
      entries: "1",
      totalEscrowValueWei: String(planPosting(pool, POLICY).totalEscrowValueWei),
      solutionMaxDeliveryRateWei: "10",
      verdictMaxDeliveryRateWei: "2",
      maxClaims: "1",
    });
  });

  test("passes the plan's terms, chain, creator, and ports straight through to postTask", async () => {
    const pool = [entry("1")];
    const { deps: d, postTask } = deps({}, pool);
    const plan = planPosting(pool, POLICY);

    await executePosting(d, plan);

    const call = postTask.mock.calls[0]!;
    expect(call[0]).toEqual(pool[0]!.taskBytes);
    expect(call[2]).toBe(plan.terms);
    expect(call[3]).toBe(CHAIN);
    expect(call[4]).toBe(plan.creatorSafe);
    expect(call[5]).toBe(d.ports);
  });

  test("records an uncertain broadcast and keeps going with the rest of the batch", async () => {
    const pool = [entry("1"), entry("2")];
    const postTask = vi.fn()
      .mockRejectedValueOnce(new BroadcastUncertainError({
        creatorSafe: POLICY.creatorSafe,
        taskCidDigest: pool[0]!.taskDigest,
        submissionDigest: `sha256:${"c".repeat(64)}`,
        idempotencyKey: "k", createdAt: POLICY.now,
      }))
      .mockResolvedValueOnce({ taskId: 5n, txHash: `0x${"ef".repeat(32)}` });
    const { deps: d, lines } = deps({ postTask }, pool);

    const summary = await executePosting(d, planPosting(pool, POLICY));

    expect(summary.uncertain).toHaveLength(1);
    expect(summary.posted).toHaveLength(1);
    expect(lines.map((line) => line.event)).toContain("posting.uncertain");
    expect(summary.spentEscrowValueWei).toBe(planPosting(pool, POLICY).entries[0]!.escrowValueWei);
  });

  test("stops on an error that is not an uncertain broadcast", async () => {
    const pool = [entry("1"), entry("2")];
    const postTask = vi.fn().mockRejectedValue(new Error("insufficient funds"));
    const { deps: d } = deps({ postTask }, pool);
    await expect(executePosting(d, planPosting(pool, POLICY))).rejects.toThrow(/insufficient funds/u);
  });

  test("refuses a plan whose entry is not in the supplied pool", async () => {
    const pool = [entry("1")];
    const { deps: d } = deps({ entries: new Map() }, pool);
    await expect(executePosting(d, planPosting(pool, POLICY))).rejects.toThrow(/not in the supplied pool/u);
  });

  test("an empty plan spends nothing and still surfaces itself", async () => {
    const { deps: d, postTask, lines } = deps({}, []);
    const summary = await executePosting(d, planPosting([], POLICY));
    expect(postTask).not.toHaveBeenCalled();
    expect(summary.spentEscrowValueWei).toBe(0n);
    expect(lines.map((line) => line.event)).toContain("posting.plan-surfaced");
  });
});

// Everything checkable about a plan is checkable before the first wei leaves. Raising a refusal
// from inside the post loop means earlier entries are already posted and escrowed when it fires,
// and the summary that would let the caller reconcile them is discarded with the throw.
describe("executePosting pre-flight", () => {
  test("validates every entry against the pool before spending on any of them", async () => {
    const pool = [entry("1"), entry("2")];
    const plan = planPosting(pool, POLICY);
    // The gap is the entry the batch would reach SECOND, so an executor that checked as it went
    // would already have posted and escrowed the first one.
    const missing = plan.entries[1]!.taskDigest;
    const { deps: d, postTask } = deps({
      entries: new Map(pool.filter((item) => item.taskDigest !== missing)
        .map((item) => [item.taskDigest, item])),
    }, pool);

    await expect(executePosting(d, plan)).rejects.toThrow(/not in the supplied pool/u);
    expect(postTask).not.toHaveBeenCalled();
  });

  test("refuses a plan entry whose escrow is not the escrow its terms imply", async () => {
    const pool = [entry("1")];
    const planned = planPosting(pool, POLICY);
    const understated = {
      ...planned,
      entries: [{ ...planned.entries[0]!, escrowValueWei: 1n }],
      totalEscrowValueWei: 1n,
    };
    const { deps: d, postTask } = deps({}, pool);

    await expect(executePosting(d, understated)).rejects.toThrow(/escrow/u);
    expect(postTask).not.toHaveBeenCalled();
  });

  test("refuses a batch whose second entry cannot be sealed, before the first one is posted", async () => {
    const plan = planPosting([entry("1"), entry("2")], POLICY);
    const unsealable = plan.entries[1]!.taskDigest;
    const pool = [entry("1"), entry("2")].map((item) => (item.taskDigest === unsealable
      ? { ...item, evaluationSpecPublic: false }
      : item));
    const { deps: d, postTask } = deps({}, pool);

    await expect(executePosting(d, plan)).rejects.toThrow(/public-specification/u);
    expect(postTask).not.toHaveBeenCalled();
  });
});
