import { describe, expect, it } from "vitest";
import { stripFinalTags } from "./final-tags.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";
import { createStreamMarkerAbsence } from "./stream-marker-absence.js";

const deliveryOptions = {
  mode: "strict",
  scope: "all",
  trim: "none",
  recoverUnclosed: false,
} as const;

// The probe must never report absence once either canonical transform would have
// changed the current text; otherwise the gated stream skips real marker work.
function assertProvenAbsenceMatchesCanonical(source: string, chunkSize: number) {
  const reasoning = createStreamMarkerAbsence({ finalTags: true, reasoningTags: true });
  const finalOnly = createStreamMarkerAbsence({ finalTags: true, reasoningTags: false });
  let accumulated = "";
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    accumulated += source.slice(offset, offset + chunkSize);
    const reasoningAbsent = reasoning(accumulated);
    const finalAbsent = finalOnly(accumulated);
    if (stripReasoningTagsFromText(accumulated, deliveryOptions) !== accumulated) {
      expect(reasoningAbsent, `missed reasoning marker at ${accumulated.length}`).toBe(false);
    }
    if (stripFinalTags(accumulated) !== accumulated) {
      expect(finalAbsent, `missed final marker at ${accumulated.length}`).toBe(false);
    }
  }
}

const chunkSizes = [1, 2, 3, 5, 7];

// Counts the characters the final-marker probe's delimiter searches touch. The
// probe only uses string methods that work on a boxed primitive, so the wrapper
// stays a runtime string that carries its own `indexOf`.
function countedDelimiters(input: string, scan: { chars: number }): string {
  const boxed = Object(input) as unknown as string;
  Object.defineProperty(boxed, "indexOf", {
    value(search: string, position?: number): number {
      const found = input.indexOf(search, position);
      if (search === "<" || search === ">") {
        const from = position ?? 0;
        scan.chars += found === -1 ? input.length - from : found - from + 1;
      }
      return found;
    },
  });
  return boxed;
}

describe("stream marker absence probe", () => {
  it.each([
    "Plain reply without markers.",
    '<div class="shell">\n  <span>rendered</span>\n</div>',
    "Compare a < b and c > d; ranges like 2<=x stay literal.",
    "Arrow a <- b and <=> operators.",
    "<thinking>secret</thinking>visible answer.",
    "</thinking>orphan close keeps text.",
    "<thinking",
    'trailing pending <thinking x="a',
    "Intro\n```text\n<thinking>literal example</thinking>\n```\nafter",
    "<final>answer</final>trailing.",
    "<final/>answer body.",
    "< final>spaced open</ final>tail.",
    "a < final> spaced.",
    "<THINKING>upper case</THINKING>shown.",
    "<antml:thinking>hidden</antml:thinking>shown.",
    '<thinking x="a<b">quoted</thinking>tail.',
    "<<<<<>>>>>",
    "<p>row 1</p>\n<p>row 2</p>",
    "carriage\r\n<thinking>hidden</thinking>\r\nvisible\r\n",
    "emoji \u{1F600} <x>y</x> \u{1F600}",
  ])("tracks canonical identity for %#", (source) => {
    for (const chunkSize of chunkSizes) {
      assertProvenAbsenceMatchesCanonical(source, chunkSize);
    }
  });

  it("proves ordinary marker-free HTML without falling back", () => {
    const source = Array.from(
      { length: 200 },
      (_value, index) => `<p class="row-${index}">Paragraph ${index} with words.</p>`,
    ).join("\n");
    const reasoning = createStreamMarkerAbsence({ finalTags: true, reasoningTags: true });
    const finalOnly = createStreamMarkerAbsence({ finalTags: true, reasoningTags: false });
    for (let offset = 0; offset < source.length; offset += 4) {
      expect(reasoning(source.slice(0, offset + 4))).toBe(true);
      expect(finalOnly(source.slice(0, offset + 4))).toBe(true);
    }
  });

  it("resolves markers split across deltas once each half arrives", () => {
    const reasoning = createStreamMarkerAbsence({ finalTags: true, reasoningTags: true });
    expect(reasoning("<thi")).toBe(true);
    expect(reasoning("<think")).toBe(true);
    expect(reasoning("<thinking")).toBe(true);
    expect(reasoning("<thinking>")).toBe(false);

    const finalOnly = createStreamMarkerAbsence({ finalTags: true, reasoningTags: false });
    expect(finalOnly("<fina")).toBe(true);
    expect(finalOnly("<final")).toBe(true);
    expect(finalOnly("<final>")).toBe(false);
  });

  it("keeps final-tag tracking independent from reasoning tags", () => {
    const finalOnly = createStreamMarkerAbsence({ finalTags: true, reasoningTags: false });
    expect(finalOnly("<thinking>kept by stripFinalTags</thinking>visible.")).toBe(true);
    expect(stripFinalTags("<thinking>kept by stripFinalTags</thinking>visible.")).toBe(
      "<thinking>kept by stripFinalTags</thinking>visible.",
    );
    const reasoning = createStreamMarkerAbsence({ finalTags: false, reasoningTags: true });
    expect(reasoning("<final>handled by the final filter</final>")).toBe(true);
  });

  it("stays sticky once absence is broken", () => {
    const probe = createStreamMarkerAbsence({ finalTags: true, reasoningTags: true });
    expect(probe("<final>answer</final>")).toBe(false);
    expect(probe("<final>answer</final> plain continuation")).toBe(false);
    expect(probe("<final>answer</final> plain continuation with no markers")).toBe(false);
  });

  it("falls back once an unresolved run outgrows the verification cap", () => {
    const probe = createStreamMarkerAbsence({ finalTags: true, reasoningTags: true });
    const pending = '<thinking x="';
    expect(probe(pending)).toBe(true);
    expect(probe(pending + " ".repeat(200))).toBe(true);
    expect(probe(pending + " ".repeat(2000))).toBe(false);
  });

  it("treats a '<' followed by non-final text as permanently dead", () => {
    const probe = createStreamMarkerAbsence({ finalTags: true, reasoningTags: false });
    const source = "no closing bracket follows: < 5 and <div and <f";
    for (let offset = 0; offset < source.length; offset += 3) {
      expect(probe(source.slice(0, offset + 3))).toBe(true);
    }
  });

  it("finds final-tag delimiters once per span in a large comparison-only reply", () => {
    const lead = "lead line\n";
    const source = `${lead}${"x < 5 and y < 6 stay literal.\n".repeat(1024)}`;
    const appended = `${source}tail < 7\n`;
    const scan = { chars: 0 };
    const appendProbe = createStreamMarkerAbsence({ finalTags: true, reasoningTags: true });
    expect(appendProbe(countedDelimiters(lead, scan))).toBe(true);
    expect(appendProbe(countedDelimiters(appended, scan))).toBe(true);
    const replaceProbe = createStreamMarkerAbsence({ finalTags: true, reasoningTags: true });
    expect(replaceProbe(countedDelimiters(source, scan))).toBe(true);
    // A per-"<" suffix rescan would touch tens of millions of characters here; one
    // monotonic pass over 1,024 comparisons stays proportional to the input.
    expect(scan.chars).toBeLessThan(appended.length * 8);
  });

  it("never reports absence once the canonical transforms would change the text (fuzz)", () => {
    const alphabet = [
      "<",
      ">",
      "/",
      '"',
      "'",
      " ",
      "\n",
      "f",
      "i",
      "n",
      "l",
      "t",
      "h",
      "k",
      "x",
      "1",
      ":",
      "\r",
      "`",
      "*",
    ];
    const markerLetters = ["f", "i", "n", "a", "l", "t", "h", "k"];
    let state = 20261016 >>> 0;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    for (let doc = 0; doc < 240; doc += 1) {
      const length = 1 + Math.floor(random() * 240);
      let source = "";
      for (let index = 0; index < length; index += 1) {
        source +=
          random() < 0.12
            ? markerLetters[Math.floor(random() * markerLetters.length)]
            : alphabet[Math.floor(random() * alphabet.length)];
      }
      const reasoning = createStreamMarkerAbsence({ finalTags: true, reasoningTags: true });
      const finalOnly = createStreamMarkerAbsence({ finalTags: true, reasoningTags: false });
      let accumulated = "";
      while (accumulated.length < source.length) {
        const chunk = 1 + Math.floor(random() * 9);
        accumulated += source.slice(accumulated.length, accumulated.length + chunk);
        const reasoningAbsent = reasoning(accumulated);
        const finalAbsent = finalOnly(accumulated);
        if (stripReasoningTagsFromText(accumulated, deliveryOptions) !== accumulated) {
          expect(reasoningAbsent, `missed reasoning marker in doc ${doc}`).toBe(false);
        }
        if (stripFinalTags(accumulated) !== accumulated) {
          expect(finalAbsent, `missed final marker in doc ${doc}`).toBe(false);
        }
      }
    }
  });
});
