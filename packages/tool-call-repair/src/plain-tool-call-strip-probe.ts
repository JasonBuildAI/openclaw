/**
 * Incremental proof that the canonical plain-text strip cannot change a streamed reply.
 *
 * `stripPlainTextToolCallBlocks` re-checks the whole reply on every delta, so a reply whose
 * visible text is unchanged still pays a full CommonMark parse per delta once a payload opener
 * has activated its projection. A relayed code block that merely quotes a tool call therefore
 * costs O(reply squared) CPU while streaming. A removal can only start at an unprotected line
 * start whose call scan completes there, so proving that no such anchor exists proves the
 * canonical transform is identity. Fence ownership comes from the shared fast path; every
 * verdict it cannot prove keeps the canonical transform in charge of the text.
 */

import { skipLineIndentation } from "./grammar.js";
import { scanPlainTextToolCall } from "./payload.js";
import {
  advanceProtectionScanState,
  createProtectionScanState,
  resolveProtectionFastPath,
} from "./protection-fast-path.js";

/**
 * Cheap necessary shape for a strip anchor at `skipLineIndentation(lineStart)`. Superset of the
 * canonical precheck in `payload.ts`: a bracket name whose payload follows on the same line or
 * behind whitespace only, a harmony channel header, or any XML-ish opener.
 */
const ANCHOR_SHAPE_RE =
  /^(?:[^\S\r\n]*(?:\[(?:tool:)?[A-Za-z0-9_-]{0,120}\]?[^\S\r\n]*(?:\r?$|[{<])|<)|[^\S\r\n]*(?:\|channel\|>)?(?:commentary|analysis|final)[ \t]+to=)/i;

export type PlainTextToolCallStripProbe = {
  /** True while the canonical strip can still change the text appended so far. */
  hasStripCandidate: (text: string) => boolean;
};

export function createPlainTextToolCallStripProbe(): PlainTextToolCallStripProbe {
  const protection = createProtectionScanState();
  /** Text already applied to `protection`; always a line start, so no partial line is carried. */
  let appliedThrough = 0;
  /** Candidate line starts whose scan may still complete on a later delta. */
  const pending = new Set<number>();
  /** Candidate line starts whose scan completes, so the canonical strip removes them. */
  const removable = new Set<number>();

  /** Rewrites only `lineStart`, so a re-check can iterate `pending` while classifying. */
  const watch = (lineStart: number, state: "removable" | "pending" | "none"): void => {
    if (state === "removable") {
      pending.delete(lineStart);
      removable.add(lineStart);
      return;
    }
    removable.delete(lineStart);
    if (state === "pending") {
      pending.add(lineStart);
    } else {
      pending.delete(lineStart);
    }
  };

  const classify = (
    text: string,
    lineStart: number,
    lineEnd: number,
    provenProtected: boolean | undefined,
  ): void => {
    if (provenProtected === true) {
      watch(lineStart, "none");
      return;
    }
    if (!ANCHOR_SHAPE_RE.test(text.slice(lineStart, lineEnd))) {
      watch(lineStart, "none");
      return;
    }
    const scan = scanPlainTextToolCall(text, skipLineIndentation(text, lineStart));
    if (scan.kind === "complete") {
      watch(lineStart, "removable");
      return;
    }
    if (scan.kind === "prefix") {
      // A still-streaming payload can complete later; a known end already owns a removal.
      watch(lineStart, scan.completeEnd === undefined ? "pending" : "removable");
      return;
    }
    // An `invalid` verdict decided by a byte already inside the text cannot change; a failure
    // at the buffer end may still complete, so keep watching it.
    watch(lineStart, scan.at < text.length ? "none" : "pending");
  };

  /** Payloads can arrive on a later delta, so unresolved candidates are re-checked every delta. */
  const recheckPending = (text: string): void => {
    for (const lineStart of pending) {
      const newline = text.indexOf("\n", lineStart);
      classify(text, lineStart, newline === -1 ? text.length : newline, undefined);
    }
  };

  const hasStripCandidate = (text: string): boolean => {
    const lastNewline = text.lastIndexOf("\n");
    const completeEnd = lastNewline + 1 > appliedThrough ? lastNewline + 1 : appliedThrough;
    if (completeEnd > appliedThrough) {
      const incoming = text.slice(appliedThrough, completeEnd);
      const isProtectedAt = resolveProtectionFastPath(protection, incoming);
      for (let lineStart = appliedThrough; lineStart < completeEnd;) {
        const newline = text.indexOf("\n", lineStart);
        const lineEnd = newline === -1 || newline >= completeEnd ? completeEnd : newline;
        classify(text, lineStart, lineEnd, isProtectedAt?.(lineStart - appliedThrough));
        lineStart = lineEnd + 1;
      }
      advanceProtectionScanState(protection, incoming);
      appliedThrough = completeEnd;
    }
    if (appliedThrough < text.length) {
      // A carried fence owns its unfinished line; an unfinished line outside one stays unproven.
      const insideFence =
        protection.fenceChar !== undefined &&
        !protection.paragraphAmbiguous &&
        !protection.structuralUnknown;
      classify(text, appliedThrough, text.length, insideFence ? true : undefined);
    }
    recheckPending(text);
    return removable.size > 0;
  };

  return { hasStripCandidate };
}
