import { expect, it, vi } from "vitest";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { createStreamingReplyResolver } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import { createAssistantVisibleStreamText } from "./embedded-agent-utils.js";

const parseWork = vi.hoisted(() => ({ scannedCharacters: 0 }));

vi.mock("../auto-reply/reply/reply-directives.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/reply/reply-directives.js")>();
  return {
    ...actual,
    parseReplyDirectives(raw: string, options?: Parameters<typeof actual.parseReplyDirectives>[1]) {
      parseWork.scannedCharacters += raw.length;
      return actual.parseReplyDirectives(raw, options);
    },
  };
});

it("streams word-boundary deltas without re-parsing the accumulated reply", () => {
  const body = "The quick brown fox jumps over the lazy dog. ".repeat(1024);
  const projection = createAssistantVisibleStreamText("final_answer");
  const directives = createStreamingDirectiveAccumulator();
  const resolve = createStreamingReplyResolver();
  let previousText = "";
  let previousCleaned = "";
  let previousAudioDirectiveCount = 0;
  let streamed = "";
  parseWork.scannedCharacters = 0;
  for (let at = 0; at < body.length; at += 4) {
    const delta = body.slice(at, at + 4);
    const projected = projection.append(delta);
    const result = resolve({
      evtType: "text_delta",
      next: projected.text,
      previousText,
      previousCleaned,
      visibleDelta: projected.delta ?? "",
      appendDelta: projected.delta,
      parsedStreamDirectives: directives.consume(delta),
      previousAudioDirectiveCount,
    });
    expect(result.replace).toBe(false);
    streamed = result.text;
    previousText = projected.text;
    previousCleaned = result.text;
    previousAudioDirectiveCount = result.audioDirectiveCount;
  }

  expect(streamed).toBe(body.trimEnd());
  // Word-boundary chunks end in whitespace, which the preview owner trims. Before
  // the append fast path, every such delta re-parsed the whole accumulated reply.
  expect(parseWork.scannedCharacters).toBeLessThan(body.length * 8);
});
