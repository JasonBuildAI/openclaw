import { describe, expect, it, vi } from "vitest";
import * as toolCallRepair from "../../../packages/tool-call-repair/src/index.js";
import {
  assistantVisibleTextFilters,
  plainToolCallTextFilter,
  sanitizeAssistantVisibleTextWithProfile,
} from "./assistant-visible-text.js";
import { findCodeRegions } from "./code-regions.js";
import { createTextProjection } from "./text-projection.js";

const reference = (text: string) =>
  toolCallRepair.stripPlainTextToolCallBlocks(text, { resolveProtectedRanges: findCodeRegions });

const samples = [
  "See sources.\n[1] A cited claim.\n[2] Another cited claim.\n[12] A third one.\n",
  'Plain prose that mentions [read] {"path": "a.ts"} mid-line.\n',
  'Visible.\n[tool:read] {"path":"a.ts"}\nDone.\n',
  'Visible.\n[read]\n{"path": "a.ts"}\n[/read]\nDone.\n',
  'Visible.\n[read]\n{"path": "a.ts"}',
  '[tool:message] {"action":"send","message":"[tool:read] {\\"path\\":\\"/app/skills/meme-maker/SKILL.md\\"}"}\n',
  "[tool:read]\n<parameter=path>\nsrc/index.ts\n</parameter>\n</function>\n",
  'Fenced:\n\n```\n[tool:read] {"path":"a.ts"}\n```\n\nAfter.\n',
  '\n\n   [tool:read] {"path":"a.ts"}\n',
  '```\n[tool:read] {\n```\n[tool:exec] {"command":"ls"}\nDone.',
  "[tool:read]\n<PARAMETER=path>src/index.ts</PARAMETER>\n",
  "<FUNCTION=read></FUNCTION>\nDone.",
  'analysis to=read code {"path":"a.ts"}\nDone.',
  'Adjacent.\n[read]\n{"path": "a.ts"}\n[/read]\n[exec]\n{"command": "ls"}\n[/exec]\nEnd.\n',
  '[tool:read]\n\n{"path": "a.ts"}\nDone.\n',
  '[tool:read] {"path":"a.ts"}\n[tool:exec] {"command":"ls"}\n',
  '[tool:read] {"path":"a.ts"}',
  "[tool:read]",
  '[tool:read] {"path"',
  'Prose first.\n[tool:read]\nStill prose.\n[tool:exec] {"command":"ls"}\n',
  '| column |\n| --- |\n[tool:read] {"path":"a.ts"}\n',
  '```text\n[tool:read] {"path":"a.ts"}\n```\nAfter.\n',
  '   commentary to=read code {"path":"a.ts"}\nDone.\n',
  '<|channel|>commentary to=functions.read<|message|>{"path":"a"}\nDone.\n',
];

/** Canonical strip work the delivery projection performs while streaming `source`. */
function canonicalWorkWhileStreaming(source: string, chunkSize: number): number {
  const strip = vi.spyOn(toolCallRepair, "stripPlainTextToolCallBlocks");
  try {
    const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      projection.append(source.slice(offset, offset + chunkSize));
    }
    expect(projection.text).toBe(sanitizeAssistantVisibleTextWithProfile(source, "delivery", true));
    return strip.mock.calls.reduce((total, [parsed]) => total + parsed.length, 0);
  } finally {
    strip.mockRestore();
  }
}

describe("plainToolCallTextFilter streamed projection", () => {
  it("bounds plain-tool-call parse work for citation replies in token-sized deltas", () => {
    const source = [
      "Here is the summary.",
      ...Array.from(
        { length: 600 },
        (_value, index) => `[${index + 1}] Ordinary sentence with words and periods.`,
      ),
      "",
    ].join("\n");
    const strip = vi.spyOn(toolCallRepair, "stripPlainTextToolCallBlocks");
    try {
      const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
      for (let offset = 0; offset < source.length; offset += 4) {
        projection.append(source.slice(offset, offset + 4));
      }
      expect(projection.text).toBe(source.trimEnd());
      // Count the canonical precheck too: ordinary citations no longer require Markdown parsing.
      const parsedCharacters = strip.mock.calls.reduce(
        (total, [parsed]) => total + parsed.length,
        0,
      );
      expect(parsedCharacters).toBeLessThan(source.length * 8);
    } finally {
      strip.mockRestore();
    }
  });

  it("bounds plain-tool-call parse work when a code block only quotes a call", () => {
    const source = [
      "Here is the block:",
      "",
      "```text",
      '[tool:read] {"path": "src/index.ts"}',
      "```",
      "",
      ...Array.from(
        { length: 600 },
        (_value, index) => `[${index + 1}] Ordinary sentence with words and periods.`,
      ),
      "",
    ].join("\n");
    // Every code block carries a payload opener, so the canonical strip used to re-parse the whole
    // reply on every delta even though it never changed a byte of it.
    expect(canonicalWorkWhileStreaming(source, 4)).toBeLessThan(source.length * 8);
  });

  it("keeps the canonical strip in charge while a call can be removed", () => {
    const source = [
      "Visible reply.",
      "",
      '[tool:read] {"path": "src/index.ts"}',
      "",
      ...Array.from({ length: 40 }, (_value, index) => `[${index + 1}] Ordinary sentence.`),
      "",
    ].join("\n");
    expect(canonicalWorkWhileStreaming(source, 4)).toBeGreaterThan(source.length);
  });

  it.each(samples)("matches the canonical strip while streaming %#", (source) => {
    for (const chunkSize of [1, 3, 5, 7]) {
      const projection = createTextProjection([plainToolCallTextFilter]);
      let accumulated = "";
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        accumulated += source.slice(offset, offset + chunkSize);
        projection.append(source.slice(offset, offset + chunkSize));
        expect(projection.text).toBe(reference(accumulated));
      }
    }
  });
});
