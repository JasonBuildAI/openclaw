// Streaming sanitizers re-run whole-reply marker scans per delta until a marker
// appears. This probe proves marker absence incrementally so the canonical
// transforms stay off the hot path while there is nothing to transform.
import { scanReasoningTags } from "../../../packages/markdown-core/src/reasoning-tags.js";
import { findFinalTagMatches } from "./final-tags.js";

// A construct that stays unresolved for longer than this is treated as a marker
// risk: callers fall back to the canonical per-delta rescan instead of
// re-verifying an unbounded tail. Ordinary prose resolves runs immediately.
const UNRESOLVED_MARKER_RUN_CAP = 1024;
const FINAL_NAME = "final";
const FINAL_NAME_WHITESPACE_CAP = 64;

/**
 * Returns a probe that reports whether the appended text is still proven free of
 * reasoning and final-answer markers. Absence is sticky: after the first marker,
 * or after any run that cannot be proven dead, every later call reports false
 * and the caller must use the canonical transform.
 */
export function createStreamMarkerAbsence(options: {
  finalTags: boolean;
  reasoningTags: boolean;
}): (text: string) => boolean {
  let reasoningSafeEnd = 0;
  let finalSafeEnd = 0;
  let sticky = false;

  const advanceReasoning = (text: string): boolean => {
    const scan = scanReasoningTags(text.slice(reasoningSafeEnd), false);
    if (scan.tags.length > 0) {
      sticky = true;
      return false;
    }
    if (scan.pendingStart === undefined) {
      reasoningSafeEnd = text.length;
      return true;
    }
    const pendingAt = reasoningSafeEnd + scan.pendingStart;
    // Canonical scanning does not wait on an unfinished construct: it rejects it
    // and resumes at that construct's next "<", which still finds a nested block
    // inside a malformed tag. Absence is provable only while the unfinished
    // construct holds no later "<" that canonical recovery could rescan.
    if (text.includes("<", pendingAt + 1)) {
      sticky = true;
      return false;
    }
    if (text.length - pendingAt > UNRESOLVED_MARKER_RUN_CAP) {
      sticky = true;
      return false;
    }
    reasoningSafeEnd = pendingAt;
    return true;
  };

  const advanceFinal = (text: string): boolean => {
    let cursor = finalSafeEnd;
    // No ">" lies between a candidate and the next ">", so every later "<" that
    // still precedes it shares that delimiter. Reusing it keeps a comparison-only
    // reply linear instead of rescanning the suffix per "<". -1 means none follows.
    let terminator = -2;
    while (cursor < text.length) {
      const lt = text.indexOf("<", cursor);
      if (lt === -1) {
        finalSafeEnd = text.length;
        return true;
      }
      if (terminator !== -1 && terminator < lt) {
        terminator = text.indexOf(">", lt);
      }
      if (terminator === -1) {
        if (openFinalTagDead(text, lt)) {
          cursor = lt + 1;
          continue;
        }
        if (text.length - lt > UNRESOLVED_MARKER_RUN_CAP) {
          sticky = true;
          return false;
        }
        finalSafeEnd = lt;
        return true;
      }
      const nextLt = text.indexOf("<", lt + 1);
      if (nextLt !== -1 && nextLt < terminator) {
        // The candidate run is cut by another "<": no final tag can start here.
        cursor = lt + 1;
        continue;
      }
      if (findFinalTagMatches(text.slice(lt, terminator + 1)).length > 0) {
        sticky = true;
        return false;
      }
      cursor = terminator + 1;
    }
    finalSafeEnd = text.length;
    return true;
  };

  return (text) => {
    if (sticky) {
      return false;
    }
    if (options.reasoningTags && !advanceReasoning(text)) {
      return false;
    }
    if (options.finalTags && !advanceFinal(text)) {
      return false;
    }
    return true;
  };
}

// Mirrors parseFinalTag's name gate on still-open text: true only when no later
// ">" can make this "<" the start of a valid final tag.
function openFinalTagDead(text: string, lt: number): boolean {
  let cursor = skipFinalNameWhitespace(text, lt + 1);
  if (cursor === -1) {
    return false;
  }
  if (text.charAt(cursor) === "/") {
    cursor = skipFinalNameWhitespace(text, cursor + 1);
    if (cursor === -1) {
      return false;
    }
  }
  for (let index = 0; index < FINAL_NAME.length; index += 1) {
    const char = text.charAt(cursor + index).toLowerCase();
    if (char === "") {
      return false;
    }
    if (char !== FINAL_NAME[index]) {
      return true;
    }
  }
  const boundary = text.charAt(cursor + FINAL_NAME.length);
  return boundary !== "" && boundary !== "/" && !/\s/u.test(boundary);
}

function skipFinalNameWhitespace(text: string, start: number): number {
  let cursor = start;
  while (/\s/u.test(text.charAt(cursor))) {
    if (cursor - start >= FINAL_NAME_WHITESPACE_CAP) {
      return -1;
    }
    cursor += 1;
  }
  return cursor;
}
