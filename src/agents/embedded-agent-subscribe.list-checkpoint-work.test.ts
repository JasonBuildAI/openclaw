import { expect, it, vi } from "vitest";
import { assistantVisibleTextFilters } from "../shared/text/assistant-visible-text.js";
import { applyTextFilters, trimTextFilter } from "../shared/text/text-projection.js";
import { userFacingTextFilters } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { createOpenAiResponsesTextEvent } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

// Every checkpoint call re-projects its retained window; counting characters here measures the
// work the shipped handler spends on settled list items.
const checkpointWork = vi.hoisted(() => ({ calls: 0, characters: 0 }));

vi.mock("../../packages/tool-call-repair/src/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../packages/tool-call-repair/src/index.js")>();
  return {
    ...actual,
    projectPlainTextToolCallBlocks(
      text: string,
      options?: Parameters<typeof actual.projectPlainTextToolCallBlocks>[1],
    ) {
      checkpointWork.calls += 1;
      checkpointWork.characters += text.length;
      return actual.projectPlainTextToolCallBlocks(text, options);
    },
  };
});

const items = Array.from(
  { length: 420 },
  (_, index) =>
    `- Step ${index} keeps the operator rollback path visible and the retry budget honest`,
);
const source = `\`\`\`json\n{"enabled":true,"steps":[1,2,3],"rollback":true}\n\`\`\`\n\n${items.join("\n")}\n`;

const filters = [
  ...assistantVisibleTextFilters("final-answer-delivery", true),
  ...userFacingTextFilters(false, true),
  trimTextFilter("both", { preserveCodeIndentation: true }),
] as const;

it("bounds checkpoint work on a 420-item list through the subscriber handler", async () => {
  checkpointWork.calls = 0;
  checkpointWork.characters = 0;
  // 98-character appends mirror the built-Gateway trace: a 33 KB answer reaches the projector as
  // ~343 coalesced provider deltas, not as 4-character chunks.
  const chunk = 98;
  const ctx = createMessageUpdateContext();
  let visible = "";
  for (let offset = 0; offset < source.length; offset += chunk) {
    await updateMessage(
      ctx,
      createOpenAiResponsesTextEvent({
        type: "text_delta",
        text: source.slice(0, offset + chunk),
        delta: source.slice(offset, offset + chunk),
        id: "msg-list",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
        messagePhase: "final_answer",
      }),
    );
    visible = ctx.state.assistantStream?.text ?? "";
  }

  expect(visible).toBe(applyTextFilters(source, [...filters]));
  // Unmodified main re-projects ~343 source lengths here; the checkpoint keeps it under 64.
  expect(checkpointWork.characters).toBeGreaterThan(0);
  expect(checkpointWork.characters).toBeLessThan(source.length * 64);
}, 120_000);
