import { afterAll, describe, expect, it, vi } from "vitest";
import * as finalTags from "../../shared/text/final-tags.js";
import { createTextProjection, type TextFilter } from "../../shared/text/text-projection.js";
import { userFacingTextFilters } from "./sanitize-user-facing-text.js";

// The filter list captures the stripFinalTags reference when it is first built,
// so the spy must be installed before any userFacingTextFilters call in this file.
const stripSpy = vi.spyOn(finalTags, "stripFinalTags");
afterAll(() => {
  stripSpy.mockRestore();
});

// The user-facing final-tag filter is the only filter whose transform turns a
// lone final marker into its visible remainder.
const finalTagProbe = "<final>a</final>b";

function finalTagFilterIndex(filters: readonly TextFilter[]): number {
  const matches = filters.filter((filter) => filter.transform(finalTagProbe) === "ab");
  expect(matches).toHaveLength(1);
  return filters.indexOf(matches[0]);
}

function withActivationReference(filters: readonly TextFilter[]): readonly TextFilter[] {
  const index = finalTagFilterIndex(filters);
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

describe("user-facing final-tag filter marker absence", () => {
  it("skips whole-reply final-tag scans for marker-free HTML replies in token-sized deltas", () => {
    const filters = userFacingTextFilters(false, true);
    const control = streamIntoProjection(withActivationReference(filters), markerFreeReply);
    stripSpy.mockClear();
    const projection = streamIntoProjection(filters, markerFreeReply);
    expect(projection.text).toBe(control.text);
    const parsedCharacters = stripSpy.mock.calls.reduce(
      (total, [parsed]) => total + parsed.length,
      0,
    );
    expect(parsedCharacters).toBeLessThan(markerFreeReply.length);
  });

  it("still strips a final tag that arrives on the last delta", () => {
    const source = `${markerFreeReply}<final>answer here</final>Tail.\n`;
    stripSpy.mockClear();
    const projection = streamIntoProjection(userFacingTextFilters(false, true), source);
    expect(projection.text).toContain("answer here");
    expect(projection.text).toContain("Tail.");
    expect(projection.text).not.toContain("<final");
    const parsedCharacters = stripSpy.mock.calls.reduce(
      (total, [parsed]) => total + parsed.length,
      0,
    );
    // A marker in the final deltas may re-run the canonical transform once per
    // remaining delta; the stale whole-reply activation re-parses from the first "<".
    expect(parsedCharacters).toBeLessThan(source.length * 16);
  });

  it.each([
    "Plain reply without markers.",
    '<div class="shell">\n  <span>rendered</span>\n</div>',
    "Compare a < b and c > d; ranges like 2<=x stay literal.",
    "<final>answer</final>trailing.",
    "<final/>answer body.",
    "a < final> spaced.",
    "< final>spaced open</ final>tail.",
    "trailing fragment <fina",
    'trailing pending <final x="a',
    "<<<<<>>>>>",
    "<p>row 1</p>\n<p>row 2</p>",
    "carriage\r\n<final>answer</final>\r\ntail\r\n",
    "emoji \u{1F600} <x>y</x> \u{1F600}",
    "<thinking>kept by stripFinalTags</thinking>visible.",
    'self closing <final answer="1"/>done.',
  ])("matches the activation-based projection stream %#", (source) => {
    const filters = userFacingTextFilters(false, true);
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
