import { expect, it, vi } from "vitest";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";
import { applyTextFilters, createTextProjection, type TextFilter } from "./text-projection.js";
import { toolCallXmlTextFilter } from "./tool-call-xml.js";

const DELTA = 4;

function prose(target: number): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < target; index += 1) {
    const line = `Step ${index}: the migration notes keep the checkpoint and settle the tail without rebuilding the reply.`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

const quotedCall =
  '<function_calls><invoke name="read_file"><parameter name="path">docs/readme.md</parameter></invoke></function_calls>\n';

function measure(filters: readonly TextFilter[], source: string) {
  const stream = createTextProjection(filters);
  const probe = vi.spyOn(RegExp.prototype, "test");
  let testedCharacters = 0;
  let delivered = "";
  try {
    for (let offset = 0; offset < source.length; offset += DELTA) {
      const result = stream.append(source.slice(offset, offset + DELTA));
      delivered = result.delta === null ? result.text : delivered + result.delta;
    }
    testedCharacters = probe.mock.calls.reduce(
      (sum, [value]) => sum + (typeof value === "string" ? value.length : 0),
      0,
    );
  } finally {
    probe.mockRestore();
  }
  return { testedCharacters, delivered, text: stream.text };
}

it("bounds sanitizer work after an unfenced tool-call quote", () => {
  const source = `Here is the call I made:\n${quotedCall}${prose(40_000)}\n`;
  const filters = [
    toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
  ];
  const result = measure(filters, source);
  console.log(
    `source=${source.length} testedCharacters=${result.testedCharacters} ratio=${(result.testedCharacters / source.length).toFixed(1)}`,
  );
  expect(result.text).toBe(applyTextFilters(source, filters));
  expect(result.delivered).toBe(applyTextFilters(source, filters));
  expect(result.testedCharacters).toBeLessThan(source.length * 8);
});

it("keeps quoted tool-call markup out of the delivered text", () => {
  const source = `Here is the call I made:\n${quotedCall}Visible answer.\n`;
  const filters = [
    toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
  ];
  const result = measure(filters, source);
  expect(result.delivered).toBe(applyTextFilters(source, filters));
  expect(result.delivered).not.toContain("function_calls");
  expect(result.delivered).toContain("Visible answer.");
});

// Every shape below either exercises the reuse path or forces the canonical
// parse; streaming and canonical output must stay identical for all of them.
const documents: string[] = [
  "plain prose without any markup at all\n",
  "Use <function> to declare it.\n",
  'Use <parameter name="path"> inside a call.\n',
  'See <invoke name="x"> and then prose follows here.\n',
  "<tool_call>\n",
  "<tool_call>",
  "before <tool_call>\n",
  "<tool_call>\n{}\n",
  '<tool_call>{"name":"read_file"}</tool_call>\nanswer\n',
  '<function_calls>\n<invoke name="read_file">\n<parameter name="path">a.md</parameter>\n</invoke>\n</function_calls>\nDone.\n',
  '<function_calls><invoke name="read_file"><parameter name="path">a.md</parameter></invoke></function_calls>',
  'Calling.\n<function_calls>\n<invoke name="read_file">\n<parameter name="path">a',
  'Calling.\n<function_calls>\n<invoke name="read_file">\n<parameter name="path">a.md</parameter>',
  '<function_response id="1">ok</function_response>\nnext line\n',
  '<function_response id="1">ok</function_response>\n',
  '<function_response id="1">ok</function_response>',
  '<function_calls><invoke name="a"></invoke></function_calls><function_response id="2">ok</function_response>\nprose\n',
  '<parameter name="path" value="a.md" />\ntail\n',
  'head\n<parameter name="path">a.md</parameter>\ntail\n',
  'head\n<parameter name="path">a.md</parameter>',
  'head\n<parameters>\n<parameter name="path">a.md</parameter>\n</parameters>\ntail\n',
  '```\n<function_calls><invoke name="x"></invoke></function_calls>\n```\ntail\n',
  '```xml\n<invoke name="x">\n<parameter name="a">b</parameter>\n</invoke>\n```\nprose\n',
  'inline `<invoke name="x">` mention then prose\n',
  "A < B and C > D, no tags here.\n",
  'HTML <div class="x">cell</div> and <table><tr><td>c</td></tr></table>\n',
  'ANTML: <antml:invoke name="x"><antml:parameter name="a">b</antml:parameter></antml:invoke>\n',
  'mm namespaced: <mm:invoke name="x"><mm:parameter name="a">b</mm:parameter></mm:invoke>\n',
  "GLM style: <tool_call>exec\n<arg_key>command</arg_key>\n<arg_value>ls</arg_value>\n</tool_call>\n",
  'nested json: <function_call>{"name":"a"}</function_call> done\n',
  'dangling <function name="a">\n',
  "closing only </invoke> here\n",
  'quoted payload: <invoke name="a">\n{"path": "a.md", "nested": {"x": 1}}\n</invoke>\nafter\n',
  'unterminated quote: <invoke name="a>rest of the reply continues here\n',
  "<tool_result>ok</tool_result>\nanswer\n",
  '<tool_calls><tool_call>{"name":"a"}</tool_call></tool_calls>\ntail\n',
  'text <function_calls> then <parameter name="a">b</parameter> then more text\n',
  `${quotedCall}answer text follows the call\n`,
  `${quotedCall}${quotedCall}twice\n`,
  // An attribute run after a preserved tag can still acquire a JSON payload, so
  // these must keep falling back to the canonical parse at every delta split.
  '<function_calls> name="read_file" {"path":"docs/readme.md"}\nvisible answer\n',
  '<function_calls> name="read_file" \n{"path":"docs/readme.md"}\nvisible answer\n',
  '<invoke name="read_file" {"path":"a.md"}\nprose\n',
  '<tool_call> name=a [{"x":1}]\nprose\n',
  '<parameter name= {"a":1}\nprose\n',
  '<function_response id="1" {"a":1}\nprose\n',
  '<function_calls> name="read_file" name="other" {"path":"a.md"}\nprose\n',
  '<invoke name="read_file"\n{"path":"a.md"}\nprose\n',
  // A later backtick or tilde can close a code span or fence around markup that is
  // already in the reply, so an append carrying one must not reuse a settled parse.
  '`<function_calls> name="read_file" {"path":"a.md"}``\n',
  "See ``</function_calls>`` here\n",
];

const configurations: Array<{ name: string; filters: readonly TextFilter[] }> = [
  {
    name: "delivery",
    filters: [toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true)],
  },
  {
    name: "user-facing",
    filters: [toolCallXmlTextFilter({ stripFunctionCallsXmlPayloads: true })],
  },
  {
    name: "delivery chain",
    filters: assistantVisibleTextFilters("delivery", true),
  },
];

it("streams the same text as the canonical sanitizer for tool-call markup", () => {
  const mismatches: string[] = [];
  for (const configuration of configurations) {
    for (const document of documents) {
      const canonical = applyTextFilters(document, configuration.filters);
      for (const delta of [1, 2, 3, 4, 5, 7, 13, 64]) {
        const stream = createTextProjection(configuration.filters);
        let delivered = "";
        for (let offset = 0; offset < document.length; offset += delta) {
          const result = stream.append(document.slice(offset, offset + delta));
          delivered = result.delta === null ? result.text : delivered + result.delta;
        }
        if (stream.text !== canonical || delivered !== canonical) {
          mismatches.push(
            `${configuration.name} delta=${delta}\n  in : ${JSON.stringify(document)}\n  can: ${JSON.stringify(canonical)}\n  txt: ${JSON.stringify(stream.text)}\n  del: ${JSON.stringify(delivered)}`,
          );
        }
      }
    }
  }
  expect(mismatches).toEqual([]);
});
