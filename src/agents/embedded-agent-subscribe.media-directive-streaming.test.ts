import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { createOpenAiResponsesTextEvent } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

// The shipped handler caches the directive owner across deltas, so the spy has to stay
// installed for the whole module and count every whole-reply parse it performs.
const parse = vi.spyOn(
  await import("../auto-reply/reply/reply-directives.js"),
  "parseReplyDirectives",
);

beforeEach(() => {
  parse.mockClear();
});
afterAll(() => {
  parse.mockRestore();
});

function characters(calls: ReadonlyArray<readonly [string, ...unknown[]]>): number {
  return calls.reduce((sum, [text]) => sum + text.length, 0);
}

const sentence =
  "The quick brown fox jumps over the lazy dog while the operator reviews one more log line. ";

function prose(chars: number): string {
  return sentence
    .repeat(Math.ceil(chars / sentence.length))
    .slice(0, chars)
    .trimEnd();
}

async function streamVisible(text: string, size: number): Promise<string> {
  const ctx = createMessageUpdateContext();
  let visible = "";
  for (let offset = 0; offset < text.length; offset += size) {
    await updateMessage(
      ctx,
      createOpenAiResponsesTextEvent({
        type: "text_delta",
        text: text.slice(0, offset + size),
        delta: text.slice(offset, offset + size),
        id: "msg-1",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
        messagePhase: "final_answer",
      }),
    );
    visible = ctx.state.assistantStream?.text ?? "";
  }
  return visible;
}

// An attachment line is stripped from the visible text, so the raw and cleaned prefixes stop
// matching and every later delta re-parsed the whole reply. A 32 KB answer with one MEDIA: line
// parsed 128.3M characters through 8,005 whole-reply directive parses before this fix.
it("keeps a media-bearing reply off the whole-reply directive parse", async () => {
  const text = `Here is the chart.\n\nMEDIA: ./chart.png\n\n${prose(32_768)}`;
  const visible = await streamVisible(text, 4);

  expect(visible.startsWith("Here is the chart.\n\n\n")).toBe(true);
  expect(visible).not.toContain("MEDIA:");
  expect(characters(parse.mock.calls)).toBeLessThan(1_000_000);
}, 30_000);

// Plain prose re-parses too whenever the preview trims a boundary; the settled-prefix append
// keeps that work bounded as well.
it("keeps ordinary prose off the whole-reply directive parse", async () => {
  const visible = await streamVisible(prose(32_768), 4);

  expect(characters(parse.mock.calls)).toBeLessThan(1_000_000);
  expect(visible).toBe(prose(32_768));
}, 30_000);

it.each([1, 3, 7, 13])(
  "matches the canonical visible text for directive shapes at %i-character deltas",
  async (size) => {
    const cases = [
      `Intro.\n\nMEDIA: ./a.png\n\nOutro ${prose(400)}`,
      `Intro.\n\nMEDIA: /tmp/x.pdf\n\nMiddle.\n\nMEDIA: ./b.png\n\nOutro ${prose(400)}`,
      `Intro [[audio_as_voice]]\n\nMEDIA: ./voice.ogg\n\nOutro ${prose(400)}`,
      `[[reply_to_current]]Intro.\n\nMEDIA: ./a.png\n\nOutro ${prose(400)}`,
      `Intro.\n\n\`\`\`text\nMEDIA: ./literal.png\n\`\`\`\n\nOutro ${prose(400)}`,
      `Intro.\n\n    MEDIA: ./indented.png\n\nOutro ${prose(400)}`,
      `Intro with [tool calls omitted] inside.\n\nMEDIA: ./a.png\n\nOutro ${prose(400)}`,
    ];
    for (const text of cases) {
      const visible = await streamVisible(text, size);
      expect(visible, JSON.stringify({ size, text: text.slice(0, 120) })).toBe(
        parseReplyDirectives(text).text,
      );
    }
  },
  60_000,
);

it("completes a media line that spans deltas without leaking it", async () => {
  const ctx = createMessageUpdateContext();
  const whole = `Here is the chart.\n\nMEDIA: ./c.png\n\nAfter.`;
  let visible = "";
  for (let offset = 0; offset < whole.length; offset += 3) {
    const nextVisible = whole.slice(0, offset + 3);
    if (/MEDIA:\s*\.\/c\.p(?:[^n]|$)/u.test(nextVisible)) {
      // A held directive tail must not be published raw.
      expect(ctx.state.assistantStream?.text ?? "").not.toContain("MEDIA: ./c.p");
    }
    await updateMessage(
      ctx,
      createOpenAiResponsesTextEvent({
        type: "text_delta",
        text: nextVisible,
        delta: whole.slice(offset, offset + 3),
        id: "msg-1",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
        messagePhase: "final_answer",
      }),
    );
    visible = ctx.state.assistantStream?.text ?? "";
    expect(visible).not.toMatch(/(?:^|\n)\s*MEDIA:\s*\S/u);
  }
  expect(visible).toBe(parseReplyDirectives(whole).text);
}, 30_000);
