import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { RUNTIME_CONTEXT_HEADER } from "../../llm/types.js";
import { createAssistantVisibleStreamText } from "../embedded-agent-utils.js";
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
  let visible = "";
  for (let offset = 0; offset < text.length; offset += size) {
    const result = stream.append(text.slice(offset, offset + size));
    visible = result.delta === null ? result.text : visible + result.delta;
  }
  return visible;
}

it("does not scrub the whole reply for ordinary English streamed text", () => {
  // Any lowercase "o" used to activate the runtime-context filter through the header's
  // first character, turning every delta into a whole-reply scan.
  const sentence =
    "The quick brown fox jumps over the lazy dog while the operator reviews one more log line. ";
  const source = sentence
    .repeat(Math.ceil(65_536 / sentence.length))
    .slice(0, 65_536)
    .trimEnd();
  const stream = createAssistantVisibleStreamText();

  expect(appendChunks(stream, source, 4)).toBe(source);
  expect(characters(scrub.mock.calls)).toBeLessThan(source.length);
});

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
