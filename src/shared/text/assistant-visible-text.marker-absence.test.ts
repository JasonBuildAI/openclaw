import { describe, expect, it, vi } from "vitest";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";
import * as reasoningTags from "./reasoning-tags.js";
import { createTextProjection, type TextFilter } from "./text-projection.js";

// The delivery reasoning filter is the only filter whose transform turns a lone
// reasoning block into its visible remainder.
const reasoningProbe = "<thinking>secret</thinking>visible";

function reasoningFilterIndex(filters: readonly TextFilter[]): number {
  const matches = filters.filter((filter) => filter.transform(reasoningProbe) === "visible");
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (!match) {
    throw new Error("expected one reasoning filter");
  }
  return filters.indexOf(match);
}

function withActivationReference(filters: readonly TextFilter[]): readonly TextFilter[] {
  const index = reasoningFilterIndex(filters);
  return filters.map((filter, cursor) =>
    cursor === index ? { transform: filter.transform, activationTokens: ["<"] as const } : filter,
  );
}

function streamIntoProjection(filters: readonly TextFilter[], source: string, chunkSize = 4) {
  const projection = createTextProjection(filters);
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    projection.append(source.slice(offset, offset + chunkSize));
  }
  return projection;
}

const markerFreeReply = [
  "Here is the rendered answer.",
  ...Array.from(
    { length: 360 },
    (_value, index) => `<p class="row-${index}">Paragraph ${index} with ordinary words.</p>`,
  ),
  "",
].join("\n");

describe("assistant visible reasoning filter marker absence", () => {
  it("skips whole-reply reasoning scans for marker-free HTML replies in token-sized deltas", () => {
    const filters = assistantVisibleTextFilters("delivery", true);
    const control = streamIntoProjection(withActivationReference(filters), markerFreeReply);
    const strip = vi.spyOn(reasoningTags, "stripReasoningTagsFromText");
    try {
      const projection = streamIntoProjection(filters, markerFreeReply);
      expect(projection.text).toBe(control.text);
      const parsedCharacters = strip.mock.calls.reduce(
        (total, [parsed]) => total + parsed.length,
        0,
      );
      expect(parsedCharacters).toBeLessThan(markerFreeReply.length);
    } finally {
      strip.mockRestore();
    }
  });

  it("still strips a reasoning block that arrives on the last delta", () => {
    const source = `${markerFreeReply}<thinking>hidden</thinking>Delivered.\n`;
    const strip = vi.spyOn(reasoningTags, "stripReasoningTagsFromText");
    try {
      const projection = streamIntoProjection(
        assistantVisibleTextFilters("delivery", true),
        source,
      );
      expect(projection.text).toContain("Delivered.");
      expect(projection.text).not.toContain("hidden");
      const parsedCharacters = strip.mock.calls.reduce(
        (total, [parsed]) => total + parsed.length,
        0,
      );
      // A marker in the final deltas may re-run the canonical transform once per
      // remaining delta; the stale whole-reply activation re-parses from the first "<".
      expect(parsedCharacters).toBeLessThan(source.length * 16);
    } finally {
      strip.mockRestore();
    }
  });

  // Canonical malformed-tag recovery scans unfinished quoted constructs with
  // final=true, which rejects the outer tag and finds the nested private block.
  it("keeps private reasoning hidden inside a malformed quoted tag", () => {
    const source = '<thinking x="<internal>private reflection</internal>';
    const projection = streamIntoProjection(assistantVisibleTextFilters("delivery", true), source);
    expect(projection.text).not.toContain("private reflection");
  });

  it("keeps a large comparison-only replacement off the canonical transform", () => {
    const source = "x < 5 and y < 6 stay literal.\n".repeat(2048);
    const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
    projection.append("x < 5");
    const strip = vi.spyOn(reasoningTags, "stripReasoningTagsFromText");
    try {
      const started = performance.now();
      const replaced = projection.replace(source);
      expect(replaced.text).toBe(source.trimEnd());
      expect(strip).not.toHaveBeenCalled();
      // The replacement path rebuilds the probe; a per-"<" suffix rescan would
      // take seconds on this input, a single span pass takes milliseconds.
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      strip.mockRestore();
    }
  });

  it.each([
    "Plain reply without markers.",
    '<div class="shell">\n  <span>rendered</span>\n</div>',
    "Compare a < b and c > d; ranges like 2<=x stay literal.",
    "<thinking>secret</thinking>visible answer.",
    "Intro\n```text\n<thinking>literal example</thinking>\n```\nafter",
    "<final/>answer body.",
    "<final>answer</final>trailing.",
    "</thinking>orphan close keeps text.",
    "<antml:thinking>hidden</antml:thinking>shown.",
    "<THINKING>upper case</THINKING>shown.",
    '<thinking x="a<b">quoted</thinking>tail.',
    "a < final> spaced.",
    "< final>spaced open</ final>tail.",
    "trailing marker fragment <thinking",
    'trailing pending <thinking x="a',
    '<thinking x="<internal>private reflection</internal>',
    '<thinking x="<internal>hidden</internal>tail',
    "<<<<<>>>>>",
    "<p>row 1</p>\n<p>row 2</p>",
    "carriage\r\n<thinking>hidden</thinking>\r\nvisible\r\n",
    "emoji \u{1F600} <x>y</x> \u{1F600}",
    'self closing <final answer="1"/>done.',
  ])("matches the activation-based projection stream %#", (source) => {
    const filters = assistantVisibleTextFilters("delivery", true);
    const reference = withActivationReference(filters);
    for (const chunkSize of [1, 3, 7]) {
      const projection = createTextProjection(filters);
      const control = createTextProjection(reference);
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        const chunk = source.slice(offset, offset + chunkSize);
        const candidate = projection.append(chunk);
        const expected = control.append(chunk);
        expect(candidate.text).toBe(expected.text);
        expect(candidate.delta).toBe(expected.delta);
      }
    }
  });
});
