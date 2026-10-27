import { describe, expect, it, vi } from "vitest";
import * as codeRegions from "./code-regions.js";
import { expectPrefixParity, regexWork, streamChunks } from "./streaming.test-support.js";
import { createTextProjection } from "./text-projection.js";
import { stripToolCallXmlTags, toolCallXmlTextFilter } from "./tool-call-xml.js";

const CHUNK = 4;

function observeMarkdownOwnership() {
  const spies = [
    vi.spyOn(codeRegions, "findCodeRegions"),
    vi.spyOn(codeRegions, "findCodeOwnership"),
  ];
  return {
    characters: () =>
      spies.reduce(
        (total, spy) => total + spy.mock.calls.reduce((sum, [text]) => sum + text.length, 0),
        0,
      ),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

function streamXml(source: string, size = CHUNK) {
  return streamChunks(
    source,
    size,
    createTextProjection([
      toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
    ]),
  );
}

function jsxAnswer(sections: number): string {
  return "```jsx\n<div><p>{items.length < 3 ? <b>Few</b> : <i>Many</i>}</p></div>\n```\n".repeat(
    sections,
  );
}

/** An ordinary HTML answer whose line length periodically leaves "<p" at a delta edge. */
function htmlAnswer(size: number, lineBreak = true): string {
  const line = "<details><summary>Result</summary><p>ordinary text</p></details>";
  return `${line}${lineBreak ? "\n" : ""}`.repeat(Math.floor(size / (line.length + 1)));
}

describe("toolCallXmlTextFilter streamed projection work", () => {
  it.each([
    ["JSX", jsxAnswer(20)],
    ["multiline HTML", htmlAnswer(16_000)],
    ["single-line HTML", htmlAnswer(16_000, false)],
  ])("bounds Markdown ownership work for ordinary %s", (_name, source) => {
    const work = observeMarkdownOwnership();
    try {
      expect(streamXml(source).text).toBe(source);
      expect(work.characters()).toBeLessThan(source.length * 2);
    } finally {
      work.restore();
    }
  });

  it("bounds whole-reply comparisons, scans, and slices at partial tag boundaries", () => {
    // Every "<" left at a delta edge holds the unfinished tag, so the projector must
    // neither re-compare, re-search, nor re-slice the accumulated reply.
    const source = htmlAnswer(48_000);
    const prefixProbe = vi.spyOn(String.prototype, "startsWith");
    const indexProbe = vi.spyOn(String.prototype, "indexOf");
    const sliceProbe = vi.spyOn(String.prototype, "slice");
    let comparedCharacters = 0;
    let searchedCharacters = 0;
    let slicedCharacters = 0;
    try {
      const streamed = streamXml(source);
      expect(streamed.text).toBe(source);
      expect(streamed.delivered).toBe(source);
      comparedCharacters = prefixProbe.mock.calls.reduce(
        (total, [search]) => total + search.length,
        0,
      );
      searchedCharacters = indexProbe.mock.calls.reduce((total, [search], index) => {
        const searched = indexProbe.mock.contexts[index];
        return total + (search === "<" && typeof searched === "string" ? searched.length : 0);
      }, 0);
      slicedCharacters = sliceProbe.mock.calls.reduce((total, [start, end], index) => {
        const sliced = sliceProbe.mock.contexts[index];
        // The held path used to materialize the visible prefix with slice(0, heldPrefix).
        return (
          total +
          (start === 0 && typeof end === "number" && end > 1024 && typeof sliced === "string"
            ? sliced.length
            : 0)
        );
      }, 0);
    } finally {
      prefixProbe.mockRestore();
      indexProbe.mockRestore();
      sliceProbe.mockRestore();
    }
    expect(comparedCharacters).toBeLessThan(source.length * 4);
    expect(searchedCharacters).toBeLessThan(source.length * 8);
    expect(slicedCharacters).toBeLessThan(source.length * 4);
  });

  it.each([
    ["<script>    <", "b"],
    ["After <a", ' href="/x">link</a>'],
  ])("keeps a held tag across replace() for %j", (held, tail) => {
    const filter = toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true);
    const projection = createTextProjection([filter]);
    const replaced = projection.replace(held);
    expect(replaced.text).toBe(held.slice(0, held.lastIndexOf("<")));
    const appended = projection.append(tail);
    const delivered = appended.delta === null ? appended.text : replaced.text + appended.delta;
    const expected = filter.transform(held + tail);
    expect(appended.text).toBe(expected);
    expect(delivered).toBe(expected);
  });

  const literalFence = "```text\n<think>literal code</think>\n```\nOrdinary prose follows.\n\n";
  it.each([
    [
      "a fenced tool-call example",
      `\`\`\`xml\n<tool_call>{"path":"a.ts"}</tool_call>\n\`\`\`\n\n${htmlAnswer(16_000)}`,
    ],
    [
      "an outer final tag before repeated fences",
      `<final>${literalFence.repeat(Math.ceil(22_000 / literalFence.length))}</final>`,
    ],
  ])("keeps partial-prefix ownership work bounded after %s", (_, source) => {
    const work = observeMarkdownOwnership();
    try {
      const filter = toolCallXmlTextFilter(
        { stripFunctionResponseAfterPluralToolCalls: true },
        true,
      );
      const projection = createTextProjection([filter]);
      let delivered = "";
      let parsedCharacters = 0;
      for (let offset = 0; offset < source.length; offset += 98) {
        const expected = filter.transform(source.slice(0, offset + 98));
        const before = work.characters();
        const result = projection.append(source.slice(offset, offset + 98));
        parsedCharacters += work.characters() - before;
        delivered = result.delta === null ? result.text : delivered + result.delta;
        expect(result.text).toBe(expected);
        expect(delivered).toBe(expected);
      }
      expect(projection.text).toBe(source);
      expect(parsedCharacters).toBeGreaterThan(0);
      expect(parsedCharacters).toBeLessThan(source.length * 2);
    } finally {
      work.restore();
    }
  });

  it("matches canonical XML projection at every chunk boundary", () => {
    const call = '<tool_call>{"path":"a.ts"}</tool_call>';
    const sources = [
      "    <",
      "\t<",
      "- item\n\n      <",
      "    < ",
      "    <\t",
      "    <p",
      "\t<p",
      " \t<p",
      "\n\n    <p",
      "text\n\n    <p",
      "```\n<tool_call>\n```\n\n<p>x</p>\n\n```\n<tool_call>{}</tool_call>\n```",
      "- item\n\n      <p",
      "- item\n    <p",
      ">     <p",
      "    <pre",
      "    " + call,
      "\t" + call,
      "text\n\n    " + call + "\n\nDone.",
      "```html\n<p",
      "```xml\n" + call + "\n```\n\n<p",
      "~~~xml\n" + call + "\n~~~",
      " ```xml\n" + call + "\n ```",
      "```bad `info\n" + call + "\n```",
      "- item\n\n  ```xml\n" + call + "\n  ```",
      "> ```xml\n> " + call + "\n> ```",
      "`<p`",
      "`" + call + "`",
      "`` `<p ``",
      "![x `" + call + "`][id]\n\n[id]: /url",
      "<pre>\n    " + call + "\n</pre>",
      "<div>\n```\n" + call + "\n```\n</div>",
      "<!--\n```\n" + call + "\n```\n-->",
      "<script>\n" + call + "\n</script>",
      "<details><summary>Result</summary><p>text</p></details>",
      "Before <",
      "Before <p",
      "Before <pre",
      "Before <tool_call",
      "Before <function",
      "Before </t",
      "Before <parameter ",
      "<\n\na\n\n<",
      "<\n\na",
      "<`</f\n\n<```",
      '<tool_call>{"path":"a.ts"}</tool_call><parameter ',
      "<parameter>value</parameter>",
      '<function name="read"><parameter name="path">a.ts</parameter></function>',
      "<tool_call>\n" + call + "\n</tool_call>",
      "&lt;tool_call&gt; &amp; <p>x</p>",
      "\r\n    <p",
      "```xml\r\n" + call + "\r\n```\r\n<p",
      "text\r\r    <p",
      'a <p b <tool_call>{"x":1}</tool_call> done',
      "<p<p",
      "<p<tool_call>{}</tool_call>",
      "<p<function",
      "<p<pre>text</pre>",
      "`<p`<p<tool_call>{}</tool_call>",
      "<tool_call>{}</tool_call><p<p",
      '[x]: / "title\n```\n<p\n"',
      "[x]: / 'title\n```\n<p\n'",
      "[x]: / (title\n```\n<p\n)",
    ].flatMap((source) => ["", "\n", "\r\n", "\n\n"].map((suffix) => source + suffix));

    for (const streaming of [false, true]) {
      const filter = toolCallXmlTextFilter(
        { stripFunctionResponseAfterPluralToolCalls: true },
        streaming,
      );
      for (const source of sources) {
        expectPrefixParity(source, () => createTextProjection([filter]), filter.transform);
      }
    }
  });

  it("still strips a tool-call tag whose name is split across deltas", () => {
    const call = '<tool_call>{"path":"a.ts"}</tool_call>';
    const source = `Before.\n${call}\nAfter.`;
    const projection = streamXml(source, 1);
    expect(projection.text).toBe(stripToolCallXmlTags(source));
    expect(projection.text).toBe("Before.\n\nAfter.");
  });

  it("still strips a tool call that follows ordinary markup", () => {
    const call = '<tool_call>{"path":"a.ts"}</tool_call>';
    const source = `${jsxAnswer(2)}\n${call}\nAfter.`;
    const projection = streamXml(source);
    expect(projection.text).toBe(stripToolCallXmlTags(source));
    expect(projection.text).not.toContain('{"path":"a.ts"}');
  });

  it("still strips a tool call behind a malformed backtick fence", () => {
    const call = '<tool_call>{"path":"a.ts"}</tool_call>';
    // CommonMark forbids backticks in a backtick fence's info string, so this line
    // does not own a code block for the canonical resolver.
    const source = `\`\`\`jsx \`code\`\n${call}\nDone.`;
    const projection = streamXml(source);
    expect(projection.text).not.toContain(call);
    expect(projection.text).not.toContain('{"path":"a.ts"}');
    expect(projection.deltas.join("")).not.toContain('{"path":"a.ts"}');
  });
});

it("bounds work after unfenced XML while continuing the visible reply", () => {
  const lead =
    'Here is the call:\n<function_calls><invoke name="read"><parameter name="path">a.md</parameter></invoke></function_calls>\n';
  const source = lead + "The next step keeps the visible answer moving.\n".repeat(200);
  const filter = toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true);
  const projection = createTextProjection([filter]);
  const testedCharacters = regexWork(() => streamChunks(source, CHUNK, projection));
  expect(projection.text).toBe(filter.transform(source));
  expect(projection.text).toContain("The next step");
  expect(projection.text).not.toContain("<invoke");
  // Includes bounded Markdown tail checks, but never a growing whole-reply scan per delta.
  expect(testedCharacters).toBeLessThan(source.length * 64);
});
