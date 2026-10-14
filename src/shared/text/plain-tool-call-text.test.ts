import { afterEach, describe, expect, it, vi } from "vitest";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import * as codeRegions from "./code-regions.js";
import { plainToolCallTextFilter } from "./plain-tool-call-text.js";
import { createTextProjection } from "./text-projection.js";

const reference = (text: string) =>
  stripPlainTextToolCallBlocks(text, { resolveProtectedRanges: codeRegions.findCodeRegions });

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
  'Adjacent.\n[read]\n{"path": "a.ts"}\n[/read]\n[exec]\n{"command": "ls"}\n[/exec]\nEnd.\n',
];

describe("plainToolCallTextFilter streamed projection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(samples)("matches the canonical strip while streaming %#", (source) => {
    for (const chunkSize of [1, 3, 7]) {
      const projection = createTextProjection([plainToolCallTextFilter]);
      let accumulated = "";
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        accumulated += source.slice(offset, offset + chunkSize);
        projection.append(source.slice(offset, offset + chunkSize));
        expect(projection.text).toBe(reference(accumulated));
      }
    }
  });

  it("keeps bracket-led prose off the canonical scan", () => {
    const regions = vi.spyOn(codeRegions, "findCodeRegions");
    const source = [
      "Here is the summary.",
      ...Array.from({ length: 40 }, (_value, index) => `[${index + 1}] Ordinary sentence.`),
      "",
    ].join("\n");
    const projection = createTextProjection([plainToolCallTextFilter]);
    for (let offset = 0; offset < source.length; offset += 4) {
      projection.append(source.slice(offset, offset + 4));
    }
    expect(projection.text).toBe(source);
    expect(regions).not.toHaveBeenCalled();
  });
});
