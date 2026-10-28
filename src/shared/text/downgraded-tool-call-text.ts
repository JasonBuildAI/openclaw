import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  consumeLineBreak,
  skipHorizontalWhitespace,
} from "../../../packages/tool-call-repair/src/grammar.js";
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import {
  createTextProjector,
  trimTextFilter,
  type TextProjector,
  trimTextPreservingCode,
  type TextFilter,
} from "./text-projection.js";

function consumeJsonish(input: string, start: number): number | null {
  let index = start;
  while (index < input.length && /[ \t\r\n]/.test(input[index] ?? "")) {
    index += 1;
  }
  const opening = input[index];
  if (opening === undefined) {
    return null;
  }
  if (opening !== "{" && opening !== "[" && opening !== '"') {
    while (index < input.length && input[index] !== "\n" && input[index] !== "\r") {
      index += 1;
    }
    return index;
  }

  // Downgraded history accepts quoted scalars and mixed container balance without JSON validation.
  let depth = opening === '"' ? 0 : 1;
  let inString = opening === '"';
  let escaped = false;
  for (index += 1; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
    if (!inString && depth === 0) {
      return index + 1;
    }
  }
  return null;
}

type DowngradedToolCallScan = {
  text: string;
  /** A candidate reaches the end of the input and can still change on append. */
  pending: boolean;
};

function scanDowngradedToolCalls(
  input: string,
  protectedRegions?: ReturnType<typeof findCodeRegions>,
): DowngradedToolCallScan {
  let codeRegions: ReturnType<typeof findCodeRegions> | undefined = protectedRegions;
  let result = "";
  let cursor = 0;
  let pending = false;
  for (const match of input.matchAll(/\[Tool Call:[^\]]*\]/gi)) {
    const start = match.index;
    if (start < cursor || isInsideCode(start, (codeRegions ??= findCodeRegions(input)))) {
      continue;
    }
    result += input.slice(cursor, start);
    let index = skipHorizontalWhitespace(input, start + match[0].length);
    index = skipHorizontalWhitespace(input, consumeLineBreak(input, index) ?? index);
    if (normalizeLowercaseStringOrEmpty(input.slice(index, index + 9)) === "arguments") {
      index += 9;
      if (input[index] === ":") {
        index += 1;
      }
      if (input[index] === " ") {
        index += 1;
      }
      const payloadEnd = consumeJsonish(input, index);
      if (payloadEnd === null) {
        // Later text can complete the argument object and hide the payload.
        pending = true;
      }
      index = payloadEnd ?? index;
    }
    if (!result || result.endsWith("\n") || result.endsWith("\r")) {
      index = consumeLineBreak(input, index) ?? index;
    }
    cursor = index;
    if (cursor === input.length || !input.includes("\n", cursor)) {
      // The next line is still streaming: appends can extend the payload test
      // (for example a partial `Arguments` keyword) or stay inside the block.
      pending = true;
    }
  }
  return { text: result + input.slice(cursor), pending };
}

/**
 * Strip downgraded tool call text representations that leak into user-visible
 * text content when replaying history across providers.
 */
export function stripDowngradedToolCallText(
  text: string,
  options?: { preserveTrailingWhitespace?: boolean },
): string {
  if (!text || (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text))) {
    return text;
  }
  const scan = scanDowngradedToolCallText(text);
  return trimTextPreservingCode(scan.text, options?.preserveTrailingWhitespace ? "start" : "both");
}

/** Batch-installed text plus whether an append can still change the hidden tail. */
function scanDowngradedToolCallText(
  text: string,
  protectedRegions?: ReturnType<typeof findCodeRegions>,
): DowngradedToolCallScan {
  if (!text || (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text))) {
    return { text, pending: false };
  }
  const scan = scanDowngradedToolCalls(text, protectedRegions);
  let cleaned = scan.text;
  let pending = scan.pending || text.lastIndexOf("[") > text.lastIndexOf("]");
  const patterns = [
    /\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi,
    /\[Historical context:[^\]]*\]\n?/gi,
  ] as const;
  for (const [patternIndex, pattern] of patterns.entries()) {
    const input = cleaned;
    let codeRegions: ReturnType<typeof findCodeRegions> | undefined =
      input === text ? protectedRegions : undefined;
    cleaned = input.replace(pattern, (match, offset: number) => {
      if (isInsideCode(offset, (codeRegions ??= findCodeRegions(input)))) {
        return match;
      }
      // Without a later tool marker this block owns everything to the end.
      if (
        offset + match.length === input.length ||
        (patternIndex === 0 && !input.slice(offset + match.length).includes("[Tool "))
      ) {
        pending = true;
      }
      return "";
    });
  }
  return { text: cleaned, pending };
}

export function downgradedToolCallTextFilter(options?: {
  preserveTrailingWhitespace?: boolean;
}): TextFilter {
  const activationTokens = ["[Tool Call", "[Tool Result", "[Historical context"] as const;
  return {
    transform: (text) => stripDowngradedToolCallText(text, options),
    create() {
      let tail = "";
      let project: TextProjector | undefined;
      return (input) => {
        if (!project) {
          const probe = tail + (input.delta ?? input.text);
          tail = probe.slice(-20);
          if (!/\[Tool (?:Call|Result)|\[Historical context/i.test(probe)) {
            return input;
          }
          project = createTextProjector([
            {
              activationTokens,
              transform: (text) => scanDowngradedToolCallText(text).text,
              checkpoint(text, boundary, context) {
                const regions = context.codeRegions();
                const scan = scanDowngradedToolCallText(text, regions);
                const prefix = scanDowngradedToolCallText(text.slice(0, boundary), regions);
                const retainStart = scan.pending || prefix.pending ? 0 : boundary;
                return {
                  text: scan.text,
                  retainStart,
                  retainedOutputStart: retainStart ? prefix.text.length : 0,
                };
              },
            },
            trimTextFilter(options?.preserveTrailingWhitespace ? "start" : "both", {
              preserveCodeIndentation: true,
            }),
          ]);
          // Activate from the complete source; earlier input has not passed through trim.
          return project({ ...input, delta: null });
        }
        return project(input);
      };
    },
  };
}
