import { describe, expect, it, vi } from "vitest";
import { userFacingTextFilters } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";
import {
  applyTextFilters,
  createTextProjection,
  trimTextFilter,
  type TextFilter,
} from "./text-projection.js";

const checkpointWork = vi.hoisted(() => ({ projectedCharacters: 0 }));

vi.mock("../../../packages/tool-call-repair/src/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/tool-call-repair/src/index.js")>();
  return {
    ...actual,
    projectPlainTextToolCallBlocks(
      text: string,
      options?: Parameters<typeof actual.projectPlainTextToolCallBlocks>[1],
    ) {
      // Every checkpoint call re-projects this window; the streamed slice must bound it.
      checkpointWork.projectedCharacters += text.length;
      return actual.projectPlainTextToolCallBlocks(text, options);
    },
  };
});

const call = '[tool:shell]\n{"command":"ls"}\n';
const fenced = '```json\n{"enabled":true}\n```\n';

const documents = [
  [
    "bulleted list after a code block",
    `${fenced}\n- First step keeps the rollback path\n- Second step restarts the worker\n`,
  ],
  [
    "bulleted list with inline code",
    `${fenced}\n- Run \`pnpm install\` first\n- Run \`pnpm test\` second\n- Run \`pnpm build\` last\n`,
  ],
  [
    "ordered list",
    `${fenced}\n1. Update the config\n2. Restart the worker\n3. Verify the status\n`,
  ],
  [
    "ordered list with multi-line items",
    `${fenced}\n1. Update the config\n   and restart the worker\n2. Verify the status\n   before the rollback\n`,
  ],
  ["nested bullets", `${fenced}\n- Parent step\n  - Child step\n  - Other child\n- Next parent\n`],
  ["loose list", `${fenced}\n- First step\n\n- Second step\n\n- Third step\n`],
  [
    "indented code inside a list item",
    `${fenced}\n- Example:\n\n      [tool:shell]\n      {"command":"ls"}\n`,
  ],
  ["candidate inside a bullet", `${fenced}\n- Use ${call.replace(/\n/g, "\n  ")}- After\n`],
  ["candidate after a list", `${fenced}\n- First step\n- Second step\n\n${call}\n`],
  ["inline span closing across items", "- Run `pnpm\n- Second step\n  command`\nAfter.\n"],
  ["list inside a blockquote", `${fenced}\n> - First step\n> - Second step\n`],
  ["CRLF bullets", `${fenced}\r\n\r\n- First step\r\n- Second step\r\n`],
  ["bullets then a reference definition", `${fenced}\n- See [ref] here\n\n[ref]: /url\n\nAfter.\n`],
  ["setext heading after bullets", `${fenced}\n- First step\n\nHeading\n=======\n\nAfter.\n`],
] as const;

const streamingFilters: readonly TextFilter[] = [
  ...assistantVisibleTextFilters("final-answer-delivery", true),
  ...userFacingTextFilters(false, true),
  trimTextFilter("both", { preserveCodeIndentation: true }),
];

function expectCanonicalPrefixes(source: string, size: number) {
  const stream = createTextProjection(streamingFilters);
  let delivered = "";
  let sourceSoFar = "";
  for (let offset = 0; offset < source.length; offset += size) {
    const chunk = source.slice(offset, offset + size);
    sourceSoFar += chunk;
    const result = stream.append(chunk);
    delivered = result.delta === null ? result.text : delivered + result.delta;
    const expected = applyTextFilters(sourceSoFar, streamingFilters);
    expect(result.text, `source: ${JSON.stringify(sourceSoFar)}`).toBe(expected);
    expect(delivered, `replayed source: ${JSON.stringify(sourceSoFar)}`).toBe(expected);
  }
}

describe.each([1, 4])("list checkpoints in %i-character deltas", (size) => {
  it.each(documents)("matches canonical output at every prefix: %s", (_name, source) => {
    expectCanonicalPrefixes(source, size);
  });
});

it("bounds checkpoint work while a bulleted list follows a code block", () => {
  const items = Array.from(
    { length: 256 },
    (_, index) => `- Step ${index} keeps the operator rollback path visible`,
  );
  const source = `${fenced}\n${items.join("\n")}\n`;
  checkpointWork.projectedCharacters = 0;
  const filters = assistantVisibleTextFilters("final-answer-delivery", true);
  const stream = createTextProjection(filters);
  for (let offset = 0; offset < source.length; offset += 4) {
    stream.append(source.slice(offset, offset + 4));
  }
  expect(stream.text).toBe(applyTextFilters(source, filters));
  expect(checkpointWork.projectedCharacters).toBeGreaterThan(0);
  expect(checkpointWork.projectedCharacters).toBeLessThan(source.length * 64);
});
