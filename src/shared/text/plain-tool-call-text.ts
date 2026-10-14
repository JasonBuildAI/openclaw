/** Streamed bracket-led prose must not reach the plain-text tool-call scan per delta. */
import { skipLineIndentation } from "../../../packages/tool-call-repair/src/grammar.js";
import {
  scanPlainTextToolCall,
  stripPlainTextToolCallBlocks,
} from "../../../packages/tool-call-repair/src/index.js";
import { findCodeRegions } from "./code-regions.js";
import { createConditionalTextProjector, type TextFilter } from "./text-projection.js";

function stripPlainToolCallText(text: string): string {
  return stripPlainTextToolCallBlocks(text, { resolveProtectedRanges: findCodeRegions });
}

function nextLineStart(text: string, offset: number): number {
  for (let index = offset; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") {
      return index + 1;
    }
  }
  return -1;
}

function lineStartAtOrAfter(text: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }
  const previous = text[offset - 1];
  return previous === "\n" || previous === "\r" ? offset : nextLineStart(text, offset);
}

/**
 * Plain-text tool calls can only start a line, and each scan verdict is final once the
 * characters that decided it are present. Carrying that progress across deltas keeps
 * bracket-led prose such as citation markers off the canonical scan.
 */
export const plainToolCallTextFilter: TextFilter = {
  transform: stripPlainToolCallText,
  create: () => {
    let scannedThrough = 0;
    let previousLength = 0;
    let active = false;
    return createConditionalTextProjector(stripPlainToolCallText, ({ text, delta }) => {
      if (active) {
        return true;
      }
      if (text.length - (delta ?? text).length !== previousLength) {
        // A rebuilt or replaced visible text cannot reuse carried scan progress.
        scannedThrough = 0;
      }
      previousLength = text.length;
      for (let at = lineStartAtOrAfter(text, scannedThrough); at !== -1 && at < text.length;) {
        const scan = scanPlainTextToolCall(text, skipLineIndentation(text, at));
        if (
          scan.kind === "complete" ||
          (scan.kind === "prefix" && scan.completeEnd !== undefined)
        ) {
          active = true;
          return true;
        }
        if (scan.kind === "prefix") {
          // An unfinished candidate can still complete; leave the partial text alone.
          scannedThrough = at;
          return false;
        }
        at = nextLineStart(text, at);
      }
      scannedThrough = text.length;
      return false;
    });
  },
};
