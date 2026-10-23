import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { RUNTIME_CONTEXT_HEADER } from "../../llm/types.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../embedded-agent-utils.js";
import * as runtimeContext from "../internal-runtime-context.js";

// Keep the spy for the whole module: filter arrays cache their transforms.
const scrub = vi.spyOn(runtimeContext, "stripInternalRuntimeContext");

// Block bodies: a hook that returns a value has it treated as a teardown callback.
beforeEach(() => {
  scrub.mockClear();
});
afterAll(() => {
  scrub.mockRestore();
});

function characters(calls: ReadonlyArray<readonly [string, ...unknown[]]>): number {
  return calls.reduce((sum, [text]) => sum + text.length, 0);
}

function appendChunks(
  stream: ReturnType<typeof createAssistantVisibleStreamText>,
  text: string,
  size: number,
): string {
  let visible = stream.text;
  for (let offset = 0; offset < text.length; offset += size) {
    const result = stream.append(text.slice(offset, offset + size));
    visible = result.delta === null ? result.text : visible + result.delta;
  }
  return visible;
}

it.each([
  ["an empty", ""],
  ["a non-empty", "Earlier preview text.\n"],
] as const)(
  "does not scrub the whole reply for ordinary English streamed text after %s replacement",
  (_label, initial) => {
    // Any lowercase "o" used to activate the runtime-context filter through the header's
    // first character, turning every delta into a whole-reply scan. The subscriber also
    // starts each projection with replace(previousStream?.raw ?? "").
    const sentence =
      "The quick brown fox jumps over the lazy dog while the operator reviews one more log line. ";
    const source = sentence
      .repeat(Math.ceil(65_536 / sentence.length))
      .slice(0, 65_536)
      .trimEnd();
    const stream = createAssistantVisibleStreamText();
    stream.replace(initial);
    scrub.mockClear();

    expect(appendChunks(stream, source, 4)).toBe(initial + source);
    expect(characters(scrub.mock.calls)).toBeLessThan(source.length);
  },
);

it("still scrubs a complete runtime-context block", () => {
  const source = [
    "Visible intro.",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "private runtime context",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_END,
    "Visible outro.",
  ].join("\n");
  const stream = createAssistantVisibleStreamText();

  expect(appendChunks(stream, source, 3)).toBe("Visible intro.\n\nVisible outro.");
  expect(characters(scrub.mock.calls)).toBeGreaterThan(0);
});

it.each([1, 2, 3, 5, 7])("withholds every partial delimiter at %i-character deltas", (size) => {
  const source = [
    "Before.",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "private runtime context",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_END,
    "After.",
  ].join("\n");
  const delimiters = [
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN,
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_END,
    RUNTIME_CONTEXT_HEADER,
  ];
  const stream = createAssistantVisibleStreamText();

  let visible = "";
  for (let offset = 0; offset < source.length; offset += size) {
    const result = stream.append(source.slice(offset, offset + size));
    visible = result.delta === null ? result.text : visible + result.delta;
    for (const delimiter of delimiters) {
      for (let length = 1; length <= Math.min(delimiter.length, visible.length); length += 1) {
        expect(visible.endsWith(delimiter.slice(0, length))).toBe(false);
      }
    }
  }

  expect(visible).toBe("Before.\n\nAfter.");
  expect(stream.text).toBe("Before.\n\nAfter.");
});

it("keeps an unterminated block hidden after a replacement", () => {
  const stream = createAssistantVisibleStreamText();
  stream.replace(`${runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN}\nsecret`);

  expect(stream.text).toBe("");
  expect(stream.append(" body\n").text).toBe("");
  expect(stream.append(`${runtimeContext.INTERNAL_RUNTIME_CONTEXT_END}\nVisible`).text).toBe(
    "Visible",
  );
});

it.each([1, 3, 5, 7])(
  "keeps the whitespace-tolerant carrier contract at %i-character deltas",
  (size) => {
    // The canonical grammar accepts any whitespace between carrier words, so a reflowed
    // preface and notice must still be stripped instead of reaching the preview.
    const source = [
      "OpenClaw runtime",
      "event.",
      "This context is runtime-generated,",
      "not user-authored. Keep internal details private.",
      "",
      "Visible reply.",
    ].join("\n");
    const stream = createAssistantVisibleStreamText();
    let visible = stream.text;
    let prefix = "";

    for (let offset = 0; offset < source.length; offset += size) {
      const chunk = source.slice(offset, offset + size);
      prefix += chunk;
      const result = stream.append(chunk);
      visible = result.delta === null ? result.text : visible + result.delta;
      expect(visible).toBe(sanitizeAssistantVisibleStreamText(prefix));
    }

    expect(visible).toBe("Visible reply.");
    expect(stream.text).toBe("Visible reply.");
  },
);
