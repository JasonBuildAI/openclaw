import { describe, expect, it } from "vitest";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import { plainToolCallTextFilter } from "./assistant-visible-text.js";
import { findCodeRegions } from "./code-regions.js";
import { createTextProjection } from "./text-projection.js";

const reference = (text: string) =>
  stripPlainTextToolCallBlocks(text, { resolveProtectedRanges: findCodeRegions });

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
];

describe("plainToolCallTextFilter streamed projection", () => {
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
});
