import { describe, expect, it } from "vitest";
import { findMarkdownCodeRegions } from "../../markdown-core/src/reasoning-tags.js";
import { projectScrubbedPlainTextToolCallMessage } from "./stream-normalizer.js";
import {
  assistantMessage,
  collectNormalizedEvents,
  doneEvent,
  errorEvent,
  matcher,
  textContent,
  textDelta,
} from "./stream-normalizer.test-support.js";

const leading = '[tool:read]\n{"path":"a"}\n';
function cumulativeDeltas(...chunks: string[]) {
  let snapshot = "";
  return chunks.map((chunk) => textDelta(chunk, (snapshot += chunk)));
}
function normalize(events: Record<string, unknown>[]) {
  return collectNormalizedEvents(events, {
    matcher,
    createPromotedToolCallEvents: () => [],
    normalizeTerminalMessage: ({ message, preserveEmptyTextBlocks }) => {
      const projection = projectScrubbedPlainTextToolCallMessage({
        matcher,
        message,
        preserveEmptyTextBlocks,
        resolveProtectedRanges: findMarkdownCodeRegions,
      });
      return projection ? { kind: "scrubbed", ...projection } : undefined;
    },
    resolveProtectedRanges: findMarkdownCodeRegions,
    protectedRangesFenceCompatible: true,
  });
}

describe("forced scrub cache invalidation", () => {
  it.each(["error", "done"] as const)(
    "scrubs a new unmarked Harmony prefix from every %s snapshot",
    async (terminal) => {
      const chunks = [leading + "Visible.\n", "a", "nalysis to=read code "];
      const message = assistantMessage(textContent(chunks.join("")));
      const events = await normalize([
        ...cumulativeDeltas(...chunks),
        terminal === "done" ? doneEvent("length", message) : errorEvent(message, message),
      ]);
      expect(JSON.stringify(events)).not.toContain("[tool:read]");
      expect(JSON.stringify(events)).not.toContain("analysis to=read");
      const last = events.at(-1);
      expect(terminal === "done" ? last?.message : last?.partial).toMatchObject({
        content: textContent("Visible.\n"),
      });
      if (terminal === "error") {
        expect(last?.error).toMatchObject({ content: textContent("Visible.\n") });
      }
    },
  );

  it.each(["error", "done"] as const)(
    "rechecks image code ownership before emitting %s snapshots",
    async (terminal) => {
      const image = 'Visible.\n\n![example `x\n[tool:read]\n{"path":"b"}\nx`][id]\n\nAfter\n\n[id]';
      const message = assistantMessage(textContent(leading + image + ": /url"));
      const events = await normalize([
        ...cumulativeDeltas(leading + image, ": /url"),
        terminal === "done" ? doneEvent("length", message) : errorEvent(message, message),
      ]);
      const resolved = events.filter((event) => JSON.stringify(event).includes("[id]: /url"));
      expect(resolved.length).toBeGreaterThan(0);
      for (const event of resolved) {
        expect(JSON.stringify(event)).not.toContain("[tool:read]");
      }
      expect(terminal === "done" ? events.at(-1)?.message : events.at(-1)?.partial).toMatchObject({
        content: textContent("Visible.\n\n![example `x\nx`][id]\n\nAfter\n\n[id]: /url"),
      });
    },
  );
});
