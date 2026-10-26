import { describe, expect, it } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";

const SENTINEL = "SECRET CONTENT";

function streamReply(params: {
  doc: string;
  chunk: number;
  phased: boolean;
  blockReplyBreak?: "text_end" | "message_end";
  emit: (evt: unknown) => void;
}) {
  const message: { role: string; phase?: string; content: unknown[] } = {
    role: "assistant",
    ...(params.phased ? { phase: "final_answer" } : {}),
    content: [],
  };
  params.emit({ type: "message_start", message });
  for (let at = 0; at < params.doc.length; at += params.chunk) {
    message.content = [{ type: "text", text: params.doc.slice(0, at + params.chunk) }];
    params.emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: params.doc.slice(at, at + params.chunk),
      },
    });
  }
  message.content = [{ type: "text", text: params.doc }];
  params.emit({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: params.doc },
  });
  params.emit({ type: "message_end", message });
}

function leaked(blocks: readonly string[]): boolean {
  return blocks.some((text) => text.includes("[tool:") || text.includes(SENTINEL));
}

describe("block reply plain-text tool calls", () => {
  it.each([
    ["empty payload calls", "[tool:read] {}\n[tool:read] {}\n"],
    [
      "write payloads",
      `[tool:write]\n{"path":"notes.txt","content":"${SENTINEL}"}\n[tool:read]\n{"path":"b"}\n`,
    ],
  ])("holds %s until the candidate settles", async (_name, doc) => {
    for (const chunk of [1, 2, 3, 4]) {
      const blocks: string[] = [];
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `block-hold-${chunk}`,
        onBlockReply: (payload) => {
          blocks.push(payload.text ?? "");
        },
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 8, maxChars: 24 },
      });
      streamReply({ doc, chunk, phased: true, emit });
      await subscription.waitForPendingEvents();
      expect(leaked(blocks), `chunk=${chunk} blocks=${JSON.stringify(blocks)}`).toBe(false);
    }
  });

  it("keeps visible prose flowing around a held call", async () => {
    const blocks: string[] = [];
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "block-hold-prose",
      onBlockReply: (payload) => {
        blocks.push(payload.text ?? "");
      },
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 8, maxChars: 40 },
    });
    streamReply({
      doc: "Intro paragraph stays visible.\n[tool:read] {}\n[tool:read] {}\nDone after the calls.\n",
      chunk: 2,
      phased: true,
      emit,
    });
    await subscription.waitForPendingEvents();
    expect(leaked(blocks)).toBe(false);
    expect(blocks.join("")).toContain("Done after the calls.");
  });

  it("delivers a fenced tool-call example as visible text", async () => {
    const blocks: string[] = [];
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "block-hold-fence",
      onBlockReply: (payload) => {
        blocks.push(payload.text ?? "");
      },
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 8, maxChars: 60 },
    });
    streamReply({
      doc: "Example:\n\n```text\n[tool:read] {}\n```\n\nAfter the example.\n",
      chunk: 3,
      phased: true,
      emit,
    });
    await subscription.waitForPendingEvents();
    expect(blocks.join("")).toContain("[tool:read] {}");
    expect(blocks.join("")).toContain("After the example.");
  });

  it("keeps ordinary prose streaming as multiple block replies", async () => {
    const blocks: string[] = [];
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "block-hold-control",
      onBlockReply: (payload) => {
        blocks.push(payload.text ?? "");
      },
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 8, maxChars: 24 },
    });
    streamReply({
      doc: "First sentence stays visible. Second sentence stays visible. Third sentence stays visible.\n",
      chunk: 4,
      phased: true,
      emit,
    });
    await subscription.waitForPendingEvents();
    expect(blocks.length).toBeGreaterThan(1);
    // Chunk boundaries may trim the separating space, so compare normalized content.
    expect(blocks.join("").replace(/\s+/gu, "")).toContain("Thirdsentencestaysvisible.");
  });
});
