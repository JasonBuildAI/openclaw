import { expect, it, vi } from "vitest";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../embedded-agent-utils.js";

// Count characters handed to the placeholder stage so a per-delta whole-reply rescan fails here
// instead of only showing up as a blocked Gateway main thread in production.
const placeholderWork = vi.hoisted(() => ({ scannedCharacters: 0 }));

vi.mock("../../shared/text/code-regions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/text/code-regions.js")>();
  return {
    ...actual,
    stripLinesOutsideCode(
      text: Parameters<typeof actual.stripLinesOutsideCode>[0],
      shouldStrip: Parameters<typeof actual.stripLinesOutsideCode>[1],
    ) {
      placeholderWork.scannedCharacters += text.length;
      return actual.stripLinesOutsideCode(text, shouldStrip);
    },
    projectLinesOutsideCode(
      text: Parameters<typeof actual.projectLinesOutsideCode>[0],
      shouldStrip: Parameters<typeof actual.projectLinesOutsideCode>[1],
      retainStart: Parameters<typeof actual.projectLinesOutsideCode>[2],
    ) {
      placeholderWork.scannedCharacters += text.length;
      return actual.projectLinesOutsideCode(text, shouldStrip, retainStart);
    },
  };
});

function streamChunks(source: string, size: number) {
  const stream = createAssistantVisibleStreamText("final_answer");
  let visible = stream.text;
  for (let offset = 0; offset < source.length; offset += size) {
    const result = stream.append(source.slice(offset, offset + size));
    visible = result.delta === null ? result.text : visible + result.delta;
  }
  return { visible, stream };
}

function expectCanonicalStream(source: string, size: number, label: string): void {
  const { visible, stream } = streamChunks(source, size);
  expect(visible, label).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
  expect(stream.text, label).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
}

function fencedTranscriptReply(target: number): string {
  let source = "```text\n$ npm run build\n(no output)\n```\n\n";
  let index = 0;
  while (source.length < target) {
    source += `Step ${index} finished with exit code ${index % 7} after ${index * 13} ms of work.\n\n`;
    index += 1;
  }
  return source.slice(0, target);
}

it.each([1, 3, 4, 7])(
  "bounds placeholder-line work for a reply that opens with a quoted empty command output at %i-character deltas",
  (size) => {
    // Regression: one quoted "(no output)" line latched the stage, and every later delta re-ran
    // the canonical scan plus its Markdown code scan over the whole accumulated reply.
    const source = fencedTranscriptReply(16_384);
    placeholderWork.scannedCharacters = 0;

    expectCanonicalStream(source, size, `deltas of ${size}`);

    expect(placeholderWork.scannedCharacters).toBeLessThan(source.length * 40);
  },
);

it.each([1, 3, 7])(
  "keeps every placeholder shape identical to the batch sanitizer at %i-character deltas",
  (size) => {
    const shapes = [
      ["plain empty command output", "$ npm run build\n(no output)\n\nDone afterwards."],
      ["spaced empty command output", "$ npm run build\n   (no output)   \n\nDone afterwards."],
      ["tool calls omitted line", "Step one.\n[tool calls omitted]\n\nDone afterwards."],
      ["quoted placeholder inside a fence", "```text\n$ npm run build\n(no output)\n```\n\nDone."],
      ["placeholder inside an indented block", "Example:\n\n    (no output)\n\nDone afterwards."],
      ["crlf transcript", "$ npm run build\r\n(no output)\r\n\r\nDone afterwards."],
      ["markdown-prefixed placeholder", "- Step one.\n- (no output)\n\nDone afterwards."],
      ["inline mention only", "The command produced (no output) and exited cleanly."],
      [
        "repeated placeholder lines",
        "(no output)\n(no output)\n\n[tool calls omitted]\n(no output)",
      ],
    ] as const;
    for (const [label, source] of shapes) {
      expectCanonicalStream(source, size, label);
    }
  },
);

it("matches the batch sanitizer when the placeholder latches after a long placeholder-free prefix", () => {
  // The stage activates late here, so the first checkpoint settles an already published prefix.
  let source = "";
  let index = 0;
  while (source.length < 8_192) {
    source += `Step ${index} finished with exit code ${index % 7} after ${index * 13} ms.\n\n`;
    index += 1;
  }
  source += "```text\n$ npm run build\n(no output)\n```\n\nAfterwards the reply continues.\n";

  const { visible, stream } = streamChunks(source, 4);
  expect(visible).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
  expect(stream.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
  expect(visible).toContain("Afterwards the reply continues.");
});

it("matches the batch sanitizer while a quoted placeholder line is still being typed", () => {
  const chunks = ["Intro.\n\n(no out", "put)", "\n", "Outro."];
  const stream = createAssistantVisibleStreamText("final_answer");
  // Trailing whitespace stays withheld from the preview by the final trim stage.
  const withoutTrailingWhitespace = (text: string) => text.replace(/[ \t\r\n]+$/u, "");
  let prefix = "";
  for (const chunk of chunks) {
    prefix += chunk;
    const result = stream.append(chunk);
    expect(withoutTrailingWhitespace(result.text)).toBe(
      withoutTrailingWhitespace(sanitizeAssistantVisibleStreamText(prefix, "final_answer")),
    );
  }
  expect(stream.text).toBe("Intro.\n\nOutro.");
});
