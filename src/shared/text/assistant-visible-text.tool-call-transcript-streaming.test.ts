import { expect, it, vi } from "vitest";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../../agents/embedded-agent-utils.js";

const ownershipWork = vi.hoisted(() => ({ scannedCharacters: 0 }));

vi.mock("../../../packages/markdown-core/src/markdown-code-regions.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../packages/markdown-core/src/markdown-code-regions.js")
    >();
  return {
    ...actual,
    findMarkdownCodeRegions(text: string) {
      ownershipWork.scannedCharacters += text.length;
      return actual.findMarkdownCodeRegions(text);
    },
    findMarkdownCodeSpans(text: string) {
      ownershipWork.scannedCharacters += text.length;
      return actual.findMarkdownCodeSpans(text);
    },
  };
});

vi.mock("./code-regions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./code-regions.js")>();
  return {
    ...actual,
    findCodeOwnership(...args: Parameters<typeof actual.findCodeOwnership>) {
      ownershipWork.scannedCharacters += args[0].length;
      return actual.findCodeOwnership(...args);
    },
    findCodeRegions(text: string) {
      ownershipWork.scannedCharacters += text.length;
      return actual.findCodeRegions(text);
    },
  };
});

const prose = (() => {
  let text = "";
  let index = 0;
  while (text.length < 8 * 1024) {
    text += `Paragraph ${index}: the quick brown fox jumps over the lazy dog and keeps writing ordinary prose for the reader.\n\n`;
    index += 1;
  }
  return text;
})();

const shapes = [
  ["legacy fenced marker", "```\n[TOOL_CALL] read {}\n[/TOOL_CALL]\n```\n\n"],
  ["legacy inline marker", "The marker `[TOOL_CALL]` is hidden from users.\n\n"],
  ["downgraded inline marker", "History shows `[Tool Call: read (ID: 1)]` to the model.\n\n"],
  ["historical inline marker", "The prompt showed `[Historical context: earlier work]`.\n\n"],
  ["downgraded marker in image alt", "![alt `[Tool Call: read (ID: 1)]` text](url)\n\n"],
  ["downgraded marker in link title", '[link](url "see `[Tool Call: read (ID: 1)]` end")\n\n'],
  [
    "legacy block in image alt",
    '![alt `[TOOL_CALL] tool => "read", args => {}[/TOOL_CALL]` text](url)\n\n',
  ],
] as const;

function streamSource(source: string, size: number) {
  const stream = createAssistantVisibleStreamText("final_answer");
  let delivered = "";
  for (let offset = 0; offset < source.length; offset += size) {
    const result = stream.append(source.slice(offset, offset + size));
    delivered = result.delta === null ? result.text : delivered + result.delta;
  }
  return { text: stream.text, delivered };
}

it.each(shapes)("bounds Markdown ownership work for a streamed %s", (_name, prefix) => {
  const source = prefix + prose;
  ownershipWork.scannedCharacters = 0;
  const { text } = streamSource(source, 4);
  expect(text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
  // The canonical sanitizer parses once; the stream must not re-parse the reply
  // per delta once the marker is inside code.
  expect(ownershipWork.scannedCharacters).toBeLessThan(1_000_000);
});

it.each(shapes)("keeps correction deltas reconstructable for a streamed %s", (_name, prefix) => {
  const source = prefix + prose;
  const expected = sanitizeAssistantVisibleStreamText(source, "final_answer");
  for (const size of [1, 3, 7]) {
    const { text, delivered } = streamSource(source, size);
    expect(text).toBe(expected);
    expect(delivered).toBe(expected);
  }
});

it("restores a downgraded marker that a split code span temporarily exposes", () => {
  const source =
    "History shows `[Tool Call: read (ID: 1)]` to the model.\n\n" +
    "The answer is straightforward.\n\n";
  const stream = createAssistantVisibleStreamText("final_answer");
  let delivered = "";
  for (const character of source) {
    const result = stream.append(character);
    delivered = result.delta === null ? result.text : delivered + result.delta;
  }
  const expected = sanitizeAssistantVisibleStreamText(source, "final_answer");
  expect(stream.text).toBe(expected);
  expect(delivered).toBe(expected);
});
