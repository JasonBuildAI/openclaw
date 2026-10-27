import { expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "./embedded-agent-utils.js";

const SENTINEL = "SECRET CONTENT";
const call = `[tool:block_reply_proof]\n{"path":"notes.txt","content":"${SENTINEL}"}\n`;
const ordinaryProse =
  "First sentence stays visible. Second sentence stays visible. Third sentence stays visible.";
const documents = {
  "late image reference":
    "![example `x\n<tool_call><function=read>{}</function></tool_call>\nx`][id]\n\n[id]: /url\n",
  "late link title":
    '[label](/url "title\n`x\n<tool_call><function=read>{}</function></tool_call>\nx` trailing\n")\n',
  "late table delimiter":
    "| Example | `x\n<tool_call><function=read>{}</function></tool_call>\nx` |\n| --- | --- |\n",
  "two-space fence": '  Example\n  ```text\n  [tool:read] {"path":"x"}\n  ```\n  Tail.',
  "four-space code": "    <tool_call><function=read>{}</function></tool_call>",
  "argument payload": call,
  "prose around a call": `Intro paragraph stays visible.\n${call}Tail paragraph stays visible.`,
  "ordinary prose": ordinaryProse,
  "less-than literal": "The expression a < b && c > d remains ordinary prose.",
  "partial tool literal": "Ordinary prose mentions <tool_ as a literal token.",
  "inline XML example": "Use `<tool_call><function=read>{}</function></tool_call>` as an example.",
  "fenced XML example":
    "Example:\n```xml\n<tool_call><function=read>{}</function></tool_call>\n```\nTail.",
  "fenced call example": 'Example:\n```text\n[tool:read] {"path":"x"}\n```\nTail.',
  "multiline inline code":
    '`\n[tool:write]\n{"content":"literal"` followed by ordinary visible text.',
  "unfinished header": "[tool:block_reply_proof",
  "unfinished payload": '[tool:block_reply_proof]\n{"content":"unfinished',
} as const;

function chunkings(text: string): string[][] {
  return [
    ...Array.from({ length: text.length + 1 }, (_, at) => [text.slice(0, at), text.slice(at)]),
    ...[1, 4].map((size) =>
      Array.from({ length: Math.ceil(text.length / size) }, (_, at) =>
        text.slice(at * size, (at + 1) * size),
      ),
    ),
  ];
}

async function streamReply(params: {
  chunks: readonly string[];
  emit: (evt: unknown) => void;
  beforeEnd?: () => Promise<void>;
}) {
  const message = { role: "assistant", phase: "final_answer", content: [] as unknown[] };
  params.emit({ type: "message_start", message });
  const projection = createAssistantVisibleStreamText("final_answer");
  let prefix = "";
  for (const delta of params.chunks) {
    prefix += delta;
    message.content = [{ type: "text", text: prefix }];
    params.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    });
    expect(projection.append(delta).text, JSON.stringify(prefix)).toBe(
      sanitizeAssistantVisibleStreamText(prefix, "final_answer"),
    );
  }
  await params.beforeEnd?.();
  params.emit({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: prefix },
  });
  params.emit({ type: "message_end", message });
}

it.each(Object.entries(documents))(
  "preserves canonical delivered bytes across every split: %s",
  async (_name, doc) => {
    const expected = sanitizeAssistantVisibleStreamText(doc, "final_answer");
    expect(expected).not.toContain(SENTINEL);
    for (const chunks of chunkings(doc)) {
      const blocks: string[] = [];
      const sources: string[] = [];
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "block-parity",
        onBlockReply: (payload) => {
          blocks.push(payload.text ?? "");
          sources.push(getReplyPayloadMetadata(payload)?.blockSourceText ?? payload.text ?? "");
        },
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 12, maxChars: 40 },
      });
      try {
        await streamReply({
          chunks,
          emit,
          beforeEnd: async () => {
            await subscription.waitForPendingEvents();
            if (_name === "ordinary prose") {
              expect(blocks.length).toBeGreaterThan(1);
            }
            if (_name.startsWith("unfinished") || _name === "multiline inline code") {
              expect(blocks).toEqual([]);
            }
          },
        });
        await subscription.waitForPendingEvents();
        // Source metadata excludes the chunker's synthetic close/reopen fences and retains
        // separators consumed at message boundaries, so compare original visible bytes.
        if (_name === "prose around a call") {
          // Separate channel messages own their boundary whitespace.
          expect(blocks.map((text) => text.trim())).toEqual(expected.split("\n"));
        } else {
          expect(sources.join("").trimEnd(), JSON.stringify({ chunks, blocks, sources })).toBe(
            expected,
          );
        }
        if (!expected) {
          expect(blocks).toEqual([]);
        }
        if (_name === "unfinished payload") {
          // A held candidate must not delay the next assistant message.
          blocks.length = 0;
          await streamReply({
            chunks: [ordinaryProse],
            emit,
            beforeEnd: async () => {
              await subscription.waitForPendingEvents();
              expect(blocks.length).toBeGreaterThan(0);
            },
          });
          await subscription.waitForPendingEvents();
        }
      } finally {
        subscription.unsubscribe();
      }
    }
  },
);
