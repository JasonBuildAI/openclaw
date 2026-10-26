import { findCodeOwnership } from "../shared/text/code-regions.js";
import type { TextFilter, TextProjector } from "../shared/text/text-projection.js";
import { stripInlineDirectiveTagsForDisplay } from "./directive-tags-batch.js";

/** Raw offsets for literal directives whose Markdown code ownership is settled. */
export type StreamDirectiveCodePrefix = {
  end: number;
  checkedRawLength: number;
};

function hasDirectiveCodePrefixOpportunity(source: string, delta: string): boolean {
  if (!delta) {
    return false;
  }
  const deltaStart = source.length - delta.length;
  const start = Math.max(0, deltaStart - 4);
  let separator = -1;
  // A following line can close block code without a blank separator; ownership proves stability.
  for (const match of source.slice(start).matchAll(/(?:\r\n|\n|\r)[^\S\r\n]*\S/g)) {
    if (start + match.index + match[0].length > deltaStart) {
      separator = start + match.index;
    }
  }
  if (separator === -1) {
    return false;
  }
  const lastMarker = source.lastIndexOf("[[");
  return lastMarker !== -1 && separator > lastMarker;
}

export function findDirectiveCodePrefix(
  source: string,
  delta: string,
): StreamDirectiveCodePrefix | undefined {
  if (!hasDirectiveCodePrefixOpportunity(source, delta)) {
    return undefined;
  }
  const { regions, retainStart, completedParagraphs } = findCodeOwnership(source);
  let regionIndex = 0;
  let paragraphIndex = 0;
  let end = 0;
  for (
    let marker = source.indexOf("[[");
    marker !== -1;
    marker = source.indexOf("[[", marker + 1)
  ) {
    let region = regions[regionIndex];
    while (region && region.end <= marker) {
      region = regions[++regionIndex];
    }
    let paragraph = completedParagraphs[paragraphIndex];
    while (paragraph && paragraph.end <= marker) {
      paragraph = completedParagraphs[++paragraphIndex];
    }
    if (!region || region.start > marker || region.end < marker + 2) {
      return undefined;
    }
    if (region.block) {
      if (region.end > retainStart) {
        return undefined;
      }
      end = region.end;
      continue;
    }
    if (
      !paragraph ||
      paragraph.hasReferenceCandidate ||
      paragraph.start > region.start ||
      paragraph.end < region.end
    ) {
      return undefined;
    }
    end = paragraph.end;
  }
  return end ? { end, checkedRawLength: source.length } : undefined;
}

type DirectiveMarkerState = {
  /** Any "[[" has appeared; earlier prose decisions can now exist. */
  seen: boolean;
  /** Markers still waiting for their closing "]]"; any of them can change on a plain append. */
  open: number;
};

/** Advances marker state by the appended bytes, including a marker split across the boundary. */
function advanceMarkerState(
  state: DirectiveMarkerState,
  previousChar: string,
  delta: string,
): void {
  const scan = previousChar + delta;
  for (let index = 1; index < scan.length; index += 1) {
    if (scan[index - 1] === "[" && scan[index] === "[") {
      state.seen = true;
      state.open += 1;
    } else if (scan[index - 1] === "]" && scan[index] === "]") {
      state.open = Math.max(0, state.open - 1);
    }
  }
}

function resolveMarkerState(text: string): DirectiveMarkerState {
  const state: DirectiveMarkerState = { seen: text.includes("[["), open: 0 };
  advanceMarkerState(state, "", text);
  return state;
}

// The bytes after "[[" are already fixed, so a marker that cannot name a directive can never
// become one. That makes its literal display independent of any later Markdown ownership.
const DIRECTIVE_NAME_PREFIXES = ["audio_as_voice", "reply_"] as const;

function isDirectiveNamePrefix(head: string): boolean {
  return DIRECTIVE_NAME_PREFIXES.some((name) =>
    head.length <= name.length ? name.startsWith(head) : head.startsWith(name),
  );
}

function hasDirectiveCandidate(text: string): boolean {
  for (let marker = text.indexOf("[["); marker !== -1; marker = text.indexOf("[[", marker + 1)) {
    const close = text.indexOf("]]", marker + 2);
    const raw = (close === -1 ? text.slice(marker + 2) : text.slice(marker + 2, close))
      .replace(/^\s+/u, "")
      .replace(/\s+$/u, "")
      .toLowerCase();
    if (close === -1) {
      if (isDirectiveNamePrefix(raw)) {
        return true;
      }
    } else if (raw === "audio_as_voice" || raw.startsWith("reply_")) {
      return true;
    }
  }
  return false;
}

/** Markdown structure that can change code ownership later in the same reply. */
const MARKDOWN_STRUCTURE_RE = /[`~|]|!\[|\]\(|\]:/u;

/** Code ownership only opens forward, so only structure before the last marker can matter. */
function hasStructureBeforeMarker(text: string): boolean {
  const marker = text.lastIndexOf("[[");
  return marker >= 0 && MARKDOWN_STRUCTURE_RE.test(text.slice(0, marker));
}

/**
 * Streams display text through the canonical strip and only re-parses when the append can
 * change its result: a new marker (also split across the boundary they share), an unfinished
 * marker this delta can complete, or Markdown structure before a marker that could still
 * withdraw its code protection. Otherwise the previous projection is extended, so one
 * directive no longer costs a whole-reply pass per delta.
 */
export const inlineDirectiveDisplayTextFilter: TextFilter = {
  transform: (text) => stripInlineDirectiveTagsForDisplay(text).text,
  create: () => {
    const markers: DirectiveMarkerState = { seen: false, open: 0 };
    let projected = "";
    let source = "";
    let previousChar = "";
    let structured = false;
    const canonical = (text: string) => {
      const previous = projected;
      projected = stripInlineDirectiveTagsForDisplay(text).text;
      source = text;
      structured = hasStructureBeforeMarker(text);
      // A literal marker stays literal; stop probing until the next "[" arrives.
      if (projected === text && !hasDirectiveCandidate(text)) {
        markers.seen = false;
      }
      // An append can remove bytes an earlier prefix already published (a completed
      // directive), so the visible delta is only safe when the output extends it.
      return {
        text: projected,
        delta: projected.startsWith(previous) ? projected.slice(previous.length) : null,
      };
    };
    const projector: TextProjector = (input) => {
      const delta = input.delta;
      if (delta === null) {
        projected = stripInlineDirectiveTagsForDisplay(input.text).text;
        source = input.text;
        previousChar = input.text.slice(-1);
        Object.assign(markers, resolveMarkerState(input.text));
        structured = hasStructureBeforeMarker(input.text);
        if (projected === input.text && !hasDirectiveCandidate(input.text)) {
          markers.seen = false;
        }
        return { text: projected, delta: null };
      }
      if (!delta) {
        return { text: projected, delta: "" };
      }
      const appended = previousChar + delta;
      if (!markers.seen && !appended.includes("[[")) {
        projected = source = input.text;
        previousChar = delta.slice(-1);
        return input;
      }
      const wasOpen = markers.open > 0;
      advanceMarkerState(markers, previousChar, delta);
      previousChar = delta.slice(-1);
      // A marker that is still open can be completed by its closing "]]" without another "[".
      const completesMarker = appended.includes("[[") || (wasOpen && delta.includes("]"));
      if (completesMarker || structured) {
        return canonical(input.text);
      }
      projected += delta;
      source = input.text;
      return projected === source ? input : { text: projected, delta };
    };
    return projector;
  },
};
