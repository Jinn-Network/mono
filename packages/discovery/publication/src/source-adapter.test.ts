import { describe, expect, it } from "vitest";
import type { AppendAnnouncementCommand, DurableSourceWriter } from "@jinn-network/record-discovery-serve";
import { executePublicationPlan, sha256 } from "./publication.js";
import { createDiscoverySourceAnnouncementPort } from "./source-adapter.js";
import type { CasResult, CasSnapshot, PublicationJournal, PublicationJournalStore, PublicationPlan } from "./types.js";

class MemoryJournal implements PublicationJournalStore {
  value: CasSnapshot<PublicationJournal> | undefined;
  revision = 0;
  async read(): Promise<CasSnapshot<PublicationJournal> | undefined> { return this.value; }
  async compareAndSwap(_id: string, expected: string | null, next: PublicationJournal): Promise<CasResult> {
    if ((this.value?.revision ?? null) !== expected) return { ok: false };
    const revision = String(++this.revision); this.value = { revision, value: next }; return { ok: true, revision };
  }
}

describe("createDiscoverySourceAnnouncementPort", () => {
  it("reuses the frozen plan timestamp after append succeeds before the journal checkpoint", async () => {
    const bytes = new TextEncoder().encode("source-adapter-record");
    let now = "2026-08-13T00:00:00.000Z";
    const timestamp = now; // plan construction freezes time; execution never reads the advancing clock.
    const plan: PublicationPlan = { id: "source-retry", stages: [{ stage: "registration", members: [{
      id: "record", kind: "https://example.test/record", digest: sha256(bytes), bytes, mediaType: "application/json",
      announcementTimestamp: timestamp, authority: { mode: "owner" }, actions: ["announce"],
    }] }] };
    const commands: AppendAnnouncementCommand[] = [];
    const returned: unknown[] = [];
    const receipt = { announcementId: "durable-source-receipt" };
    const writer = {
      async append(command: AppendAnnouncementCommand) {
        commands.push(command);
        if (commands.length === 2) expect(command).toEqual(commands[0]);
        returned.push(receipt);
        return receipt;
      },
    } as unknown as DurableSourceWriter;
    const journal = new MemoryJournal();
    let crash = true;
    const dependencies = {
      journal,
      objects: { async putExact() {} },
      authority: { async authorizeAnnouncement() {} },
      announce: createDiscoverySourceAnnouncementPort({ writer }),
    };

    await expect(executePublicationPlan(plan, {
      ...dependencies,
      faults: { async at({ action }) { if (action === "announce" && crash) { crash = false; throw new Error("after-append"); } } },
    })).rejects.toThrow("after-append");
    now = "2026-08-13T00:01:00.000Z";
    await executePublicationPlan(plan, dependencies);

    expect(now).toBe("2026-08-13T00:01:00.000Z");
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.timestamp)).toEqual([timestamp, timestamp]);
    expect(returned[1]).toBe(returned[0]);
  });
});
