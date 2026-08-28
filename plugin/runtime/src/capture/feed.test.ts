import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "../errors.js";
import {
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  controlledInputEntityId,
  executorIri,
} from "./identity.js";
import { parseSessionFeed } from "./feed.js";

const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(new URL(`../../fixtures/capture/${name}`, import.meta.url)));

const encode = (lines: readonly unknown[]): Uint8Array =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

const open = {
  type: "session-open",
  v: 1,
  sessionId: "s-1",
  startedAt: "2026-07-30T09:00:00Z",
  atUnixNano: "1000",
  host: { name: "Hermes", version: "0.9.1" },
  model: { provider: "anthropic", name: "claude-opus-4.6" },
};
const close = {
  type: "session-close",
  atUnixNano: "9000",
  endedAt: "2026-07-30T09:00:06Z",
  outcome: "completed",
  summary: "s",
};

describe("session feed identity", () => {
  test("declares one format IRI and media type for the feed", () => {
    expect(SESSION_FEED_FORMAT_IRI).toBe("https://spec.jinn.network/formats/agent-session-feed/v1");
    expect(SESSION_FEED_MEDIA_TYPE).toBe("application/x-ndjson");
  });

  test("derives an absolute executor IRI from the host name", () => {
    expect(executorIri("Hermes")).toBe("https://spec.jinn.network/software/agent-host/hermes");
    expect(executorIri("Claude Code")).toBe("https://spec.jinn.network/software/agent-host/claude-code");
    expect(() => executorIri("  ")).toThrow(PluginRuntimeError);
  });
});

describe("parseSessionFeed", () => {
  test("parses the golden feed with stable line ordinals", async () => {
    const feed = parseSessionFeed(await fixture("session.ndjson"));
    expect(feed.sessionId).toBe("s-golden");
    expect(feed.open.host.name).toBe("Hermes");
    expect(feed.close?.outcome).toBe("completed");
    expect(feed.lines).toHaveLength(8);
    expect(feed.lines.map((line) => line.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(feed.lines[3]?.event.type).toBe("tool-call");
    expect(feed.tokens).toEqual({ inputTokens: 1024, outputTokens: 256 });
    expect(feed.environment).toEqual({
      tools: ["read_file", "write_file"],
      skills: ["superpowers:writing-plans"],
    });
  });

  test("parses a feed carrying nothing but its open and close", async () => {
    const feed = parseSessionFeed(await fixture("session-minimal.ndjson"));
    expect(feed.lines).toHaveLength(2);
    expect(feed.tokens).toBeUndefined();
    expect(feed.environment).toBeUndefined();
  });

  test("tolerates a feed with no close event", () => {
    const feed = parseSessionFeed(encode([open]));
    expect(feed.close).toBeUndefined();
  });

  test("rejects bytes that are not valid UTF-8", () => {
    expect(() => parseSessionFeed(new Uint8Array([0xff, 0xfe]))).toThrow(PluginRuntimeError);
  });

  test("rejects a line that is not JSON, naming the ordinal", () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(open)}\nnot json\n`);
    expect(() => parseSessionFeed(bytes)).toThrow(/line 1/u);
  });

  test("rejects an unknown event type and an unknown key", () => {
    expect(() => parseSessionFeed(encode([open, { type: "mystery", atUnixNano: "2000" }]))).toThrow(
      PluginRuntimeError,
    );
    expect(() =>
      parseSessionFeed(encode([open, { type: "user-turn", atUnixNano: "2000", text: "x", extra: 1 }])),
    ).toThrow(PluginRuntimeError);
  });

  test("requires session-open first and exactly once", () => {
    expect(() => parseSessionFeed(encode([{ type: "user-turn", atUnixNano: "1", text: "x" }]))).toThrow(
      /session-open/u,
    );
    expect(() => parseSessionFeed(encode([open, open]))).toThrow(/session-open/u);
    expect(() => parseSessionFeed(new Uint8Array())).toThrow(/session-open/u);
  });

  test("requires session-close to be last and at most once", () => {
    expect(() =>
      parseSessionFeed(encode([open, close, { type: "user-turn", atUnixNano: "9500", text: "x" }])),
    ).toThrow(/session-close/u);
  });

  test("requires non-decreasing timestamps", () => {
    expect(() =>
      parseSessionFeed(encode([open, { type: "user-turn", atUnixNano: "500", text: "x" }])),
    ).toThrow(/non-decreasing/u);
  });

  test("requires a tool call to end no earlier than it started", () => {
    expect(() =>
      parseSessionFeed(
        encode([
          open,
          {
            type: "tool-call",
            startedAtUnixNano: "5000",
            atUnixNano: "2000",
            toolName: "t",
            toolCallId: "c",
            status: "ok",
            arguments: "{}",
            result: "",
          },
        ]),
      ),
    ).toThrow(/tool call/u);
  });

  test("requires the close wall clock not to precede the open wall clock", () => {
    expect(() =>
      parseSessionFeed(encode([open, { ...close, endedAt: "2026-07-30T08:59:59Z" }])),
    ).toThrow(/endedAt/u);
  });

  test("rejects timestamps that are not unsigned decimal strings", () => {
    expect(() => parseSessionFeed(encode([{ ...open, atUnixNano: 1000 }]))).toThrow(PluginRuntimeError);
    expect(() => parseSessionFeed(encode([{ ...open, atUnixNano: "0100" }]))).toThrow(PluginRuntimeError);
  });

  test("rejects a non-RFC3339 wall clock", () => {
    expect(() => parseSessionFeed(encode([{ ...open, startedAt: "2026-07-30 09:00:00" }]))).toThrow(
      PluginRuntimeError,
    );
  });

  test("rejects a feed version this build does not implement", () => {
    expect(() => parseSessionFeed(encode([{ ...open, v: 2 }]))).toThrow(PluginRuntimeError);
  });

  test("keeps the last tokens and environment event when repeated", () => {
    const feed = parseSessionFeed(
      encode([
        open,
        { type: "tokens", atUnixNano: "2000", inputTokens: 1, outputTokens: 2 },
        { type: "tokens", atUnixNano: "3000", inputTokens: 10, outputTokens: 20 },
      ]),
    );
    expect(feed.tokens).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});

describe("repository-state", () => {
  const repositoryState = {
    type: "repository-state",
    atUnixNano: "1500",
    repository: "https://github.com/Jinn-Network/mono",
    branch: "autopilot/3223",
    targetBase: "next",
    baseCommit: "a".repeat(40),
    baseTree: "b".repeat(40),
  };

  test("carries the base commit and tree the fixture found missing", () => {
    const feed = parseSessionFeed(encode([open, repositoryState, close]));
    expect(feed.repositoryState).toEqual(repositoryState);
  });

  test("is optional — a feed without one parses unchanged", () => {
    expect(parseSessionFeed(encode([open, close])).repositoryState).toBeUndefined();
  });

  test("refuses a second repository-state rather than silently keeping one", () => {
    expect(() =>
      parseSessionFeed(encode([open, repositoryState, repositoryState, close])),
    ).toThrow(/repository-state/u);
  });

  test("keeps the commit and tree when the branch and target base are unknown", () => {
    const { branch, targetBase, ...withoutContext } = repositoryState;
    const feed = parseSessionFeed(encode([open, withoutContext, close]));
    expect(feed.repositoryState?.baseCommit).toBe("a".repeat(40));
    expect(feed.repositoryState?.branch).toBeUndefined();
  });

  test("refuses a blank branch or target base", () => {
    for (const over of [{ branch: " " }, { targetBase: "  " }]) {
      expect(() =>
        parseSessionFeed(encode([open, { ...repositoryState, ...over }, close])),
      ).toThrow(PluginRuntimeError);
    }
  });

  test("requires full-length lowercase hex object names", () => {
    for (const bad of ["a".repeat(39), "A".repeat(40), "g".repeat(40)]) {
      expect(() =>
        parseSessionFeed(encode([open, { ...repositoryState, baseCommit: bad }, close])),
      ).toThrow(PluginRuntimeError);
    }
  });

  test("accepts a SHA-256 object name for a repository that uses one", () => {
    const feed = parseSessionFeed(
      encode([
        open,
        { ...repositoryState, baseCommit: "c".repeat(64), baseTree: "d".repeat(64) },
        close,
      ]),
    );
    expect(feed.repositoryState?.baseCommit).toBe("c".repeat(64));
  });
});

describe("controlled-input", () => {
  const controlled = (over: Record<string, unknown> = {}) => ({
    type: "controlled-input",
    atUnixNano: "1600",
    role: "workflow",
    name: "implement-issue/SKILL.md",
    mediaType: "text/markdown",
    contentBase64: Buffer.from("# implement-issue\n").toString("base64"),
    ...over,
  });

  test("collects every controlled input in feed order", () => {
    const feed = parseSessionFeed(
      encode([
        open,
        controlled(),
        controlled({ role: "config", name: "effective-config.json", mediaType: "application/json" }),
        close,
      ]),
    );
    expect(feed.controlledInputs.map((entry) => entry.role)).toEqual(["workflow", "config"]);
    expect(new TextDecoder().decode(feed.controlledInputs[0]!.bytes)).toBe("# implement-issue\n");
  });

  test("is optional — a feed without any yields an empty list", () => {
    expect(parseSessionFeed(encode([open, close])).controlledInputs).toEqual([]);
  });

  test("rejects an unknown role rather than recording an uninterpretable input", () => {
    expect(() => parseSessionFeed(encode([open, controlled({ role: "secrets" }), close]))).toThrow(
      PluginRuntimeError,
    );
  });

  test("rejects content that is not base64", () => {
    expect(() =>
      parseSessionFeed(encode([open, controlled({ contentBase64: "not base64!" }), close])),
    ).toThrow(PluginRuntimeError);
  });

  test("refuses an input larger than the per-input bound", () => {
    const oversized = Buffer.alloc(256 * 1024 + 1, 0x61).toString("base64");
    expect(() =>
      parseSessionFeed(encode([open, controlled({ contentBase64: oversized }), close])),
    ).toThrow(/bytes/u);
  });

  test("refuses a grossly oversized string before decoding it", () => {
    const huge = Buffer.alloc(1024 * 1024, 0x61).toString("base64");
    expect(() =>
      parseSessionFeed(encode([open, controlled({ contentBase64: huge }), close])),
    ).toThrow(PluginRuntimeError);
  });

  test("refuses a zero-byte input, which would bind nothing", () => {
    expect(() =>
      parseSessionFeed(encode([open, controlled({ contentBase64: "" }), close])),
    ).toThrow(PluginRuntimeError);
  });

  test("refuses blank strings the recorder would reject deep inside the seal", () => {
    for (const over of [{ name: "   " }, { mediaType: " " }]) {
      expect(() => parseSessionFeed(encode([open, controlled(over), close]))).toThrow(
        PluginRuntimeError,
      );
    }
  });

  test("refuses more controlled inputs than the per-session bound", () => {
    const many = Array.from({ length: 33 }, (_, index) => controlled({ name: `skill-${index}.md` }));
    expect(() => parseSessionFeed(encode([open, ...many, close]))).toThrow(/controlled-input/u);
  });
});

describe("hosted model service identity", () => {
  test("records the full service identity when the host reports one", () => {
    const service = {
      iri: "https://spec.jinn.network/services/anthropic/claude-opus-5",
      name: "Anthropic Messages API",
      version: "claude-opus-5-20260514",
      deployment: "api.anthropic.com",
      providerIri: "https://spec.jinn.network/organizations/anthropic",
    };
    const feed = parseSessionFeed(
      encode([{ ...open, model: { ...open.model, service } }, close]),
    );
    expect(feed.open.model.service).toEqual(service);
  });

  test("is optional — an unreported service leaves the bare label alone", () => {
    expect(parseSessionFeed(encode([open, close])).open.model.service).toBeUndefined();
  });

  test("refuses a service IRI that is already the executor or producer identity", () => {
    for (const iri of [
      "https://spec.jinn.network/software/agent-host/hermes",
      "https://spec.jinn.network/software/plugin-runtime",
    ]) {
      expect(() =>
        parseSessionFeed(encode([{ ...open, model: { ...open.model, service: { iri } } }, close])),
      ).toThrow(/identity/u);
    }
  });

  test("refuses a service that names itself as its own provider", () => {
    const iri = "https://spec.jinn.network/services/anthropic/claude-opus-5";
    expect(() =>
      parseSessionFeed(
        encode([{ ...open, model: { ...open.model, service: { iri, providerIri: iri } } }, close]),
      ),
    ).toThrow(/provider/u);
  });

  test("rejects a service identity that is not an absolute IRI", () => {
    expect(() =>
      parseSessionFeed(
        encode([{ ...open, model: { ...open.model, service: { iri: "claude-opus-5" } } }, close]),
      ),
    ).toThrow(PluginRuntimeError);
  });
});

describe("controlledInputEntityId", () => {
  test("keeps a host-written name from reaching the crate as a path", () => {
    expect(controlledInputEntityId(0, "../../etc/passwd")).toBe("inputs/controlled/00-etc-passwd");
    expect(controlledInputEntityId(1, "a?b#c\\d")).toBe("inputs/controlled/01-a-b-c-d");
  });

  test("yields a distinct id for names that slug the same", () => {
    expect(controlledInputEntityId(0, "SKILL.md")).not.toBe(controlledInputEntityId(1, "skill.md"));
  });

  test("still yields an id for a name with nothing sluggable in it", () => {
    expect(controlledInputEntityId(2, "\u65e5\u672c\u8a9e")).toBe("inputs/controlled/02-input");
  });
});
