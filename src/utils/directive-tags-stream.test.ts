import { describe, expect, it, vi } from "vitest";
import { createTextProjection, type TextFilter } from "../shared/text/text-projection.js";
import { stripInlineDirectiveTagsForDisplay } from "./directive-tags-batch.js";
import { inlineDirectiveDisplayTextFilter } from "./directive-tags-stream.js";

const work = vi.hoisted(() => ({ characters: 0, calls: 0 }));

vi.mock("./directive-tags-batch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./directive-tags-batch.js")>();
  return {
    ...actual,
    stripInlineDirectiveTagsForDisplay(text: string) {
      work.calls += 1;
      work.characters += text.length;
      return actual.stripInlineDirectiveTagsForDisplay(text);
    },
  };
});

const filters: readonly TextFilter[] = [inlineDirectiveDisplayTextFilter];

const documents = [
  ["reply directive at the start", "[[reply_to_current]]\n\nAnswer paragraph.\n"],
  ["audio directive", "[[audio_as_voice]]\nVoice answer.\n"],
  ["two directives", "[[reply_to_current]]\n[[audio_as_voice]]\nDone.\n"],
  ["directive mid reply", "Intro.\n\n[[reply_to_current]]\n\nAnswer.\n"],
  ["wiki link", "See [[Architecture Notes]] for the background.\n"],
  ["nested array in prose", "The matrix [[1,2],[3,4]] appears here.\n"],
  ["directive completed across deltas", "Before [[audio_as_voice]] after.\n"],
  ["unfinished directive then closer", "Before [[audio_as_voice] then ] after.\n"],
  ["directive in inline code", "Use `[[audio_as_voice]]` literally.\n"],
  ["late inline closer", "Literal `code [[audio_as_voice]]` stays.\n"],
  ["fenced directive", "```\n[[audio_as_voice]]\n```\n\nAfter.\n"],
  ["crlf directive", "[[reply_to_current]]\r\n\r\nAnswer.\r\n"],
  ["directive then backtick prose", "[[reply_to_current]]\n\nCall `run()` now.\n"],
  ["unclosed backtick before directive", "Literal `start [[audio_as_voice]] tail\n"],
] as const;

function projectPrefixes(source: string, size: number) {
  const stream = createTextProjection(filters);
  let accumulated = "";
  let delivered = "";
  for (let offset = 0; offset < source.length; offset += size) {
    const chunk = source.slice(offset, offset + size);
    accumulated += chunk;
    const result = stream.append(chunk);
    delivered = result.delta === null ? result.text : delivered + result.delta;
    expect(result.text, JSON.stringify({ source, accumulated })).toBe(
      stripInlineDirectiveTagsForDisplay(accumulated).text,
    );
    expect(delivered, JSON.stringify({ source, accumulated })).toBe(
      stripInlineDirectiveTagsForDisplay(accumulated).text,
    );
  }
}

describe("streaming inline directive display", () => {
  it.each(documents)("matches the canonical projection at every prefix: %s", (_name, source) => {
    for (const size of [1, 2, 3, 4, 7]) {
      projectPrefixes(source, size);
    }
  });

  it("recomputes the whole projection on replacements", () => {
    const stream = createTextProjection(filters);
    stream.append("[[reply_to_current]]\n\nFirst.");
    expect(stream.replace("Second [[audio_as_voice]] text.").text).toBe("Second  text.");
    expect(stream.append(" More.").text).toBe("Second  text. More.");
  });

  it("bounds canonical passes after one directive in a long reply", () => {
    work.calls = 0;
    work.characters = 0;
    let body = "";
    for (let index = 1; body.length < 32 * 1024; index += 1) {
      body += `Paragraph ${index} keeps ordinary prose streaming through the live chat display.\n\n`;
    }
    const source = `[[reply_to_current]]\n\n${body}`;
    const stream = createTextProjection(filters);
    let delivered = "";
    for (let offset = 0; offset < source.length; offset += 4) {
      const result = stream.append(source.slice(offset, offset + 4));
      delivered = result.delta === null ? result.text : delivered + result.delta;
    }
    const expected = stripInlineDirectiveTagsForDisplay(source).text;
    expect(stream.text).toBe(expected);
    expect(delivered).toBe(expected);
    // One canonical pass per marker-bearing or code-marker delta, never per plain delta.
    expect(work.calls).toBeLessThanOrEqual(64);
    expect(work.characters).toBeLessThanOrEqual(source.length * 4);
  });
});
