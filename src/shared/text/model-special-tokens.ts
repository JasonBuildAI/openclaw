// Model special token helpers strip model control tokens outside code regions.
import { findCodeOwnership } from "./code-regions.js";
import type { TextFilter, TextProjection } from "./text-projection.js";

// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
// Control tokens never contain whitespace; prose operators like `<|` ... `|>` do.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜\s]*[|｜]>/g;
// A delta can split the two-character opener, so activation carries one trailing character.
const TOKEN_START_RE = /<[|｜]/;

function findLastPipe(text: string, fromIndex: number): number {
  return Math.max(text.lastIndexOf("|", fromIndex), text.lastIndexOf("｜", fromIndex));
}

// A trailing `<`, `<|body`, or `<|body|` can still become a token when the stream continues.
// The body may itself contain `<`, so the opener is found from its pipes, not the last `<`.
function endsWithIncompleteTokenPrefix(text: string): boolean {
  if (text.endsWith("<")) {
    return true;
  }
  const closePipe = findLastPipe(text, text.length - 1);
  if (closePipe < 1) {
    return false;
  }
  if (closePipe === text.length - 1) {
    const openPipe = findLastPipe(text, closePipe - 1);
    if (openPipe > 0 && text[openPipe - 1] === "<") {
      return true;
    }
    return text[closePipe - 1] === "<";
  }
  if (text[closePipe - 1] !== "<") {
    return false;
  }
  return !/[\s|｜]/.test(text.slice(closePipe + 1));
}

function endsWithCompleteToken(text: string): boolean {
  if (!text.endsWith(">")) {
    return false;
  }
  const closePipe = findLastPipe(text, text.length - 2);
  if (closePipe < 1) {
    return false;
  }
  const openPipe = findLastPipe(text, closePipe - 1);
  return (
    openPipe > 0 &&
    text[openPipe - 1] === "<" &&
    !/[\s|｜]/.test(text.slice(openPipe + 1, closePipe))
  );
}

// A token followed by half of a surrogate pair still has an undecided separator.
function endsWithTokenBeforeIncompleteSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF]$/u.test(text) && endsWithCompleteToken(text.slice(0, -1));
}

type CodeSpan = { start: number; end: number };

/**
 * Code spans inside image syntax keep their ownership only until the image resolves:
 * an inline `)` completes it, and a matching reference definition can revoke it at any
 * later character. While a kept token still sits in one of those spans, appends cannot
 * be trusted and the canonical transform must re-check the ownership. This mirrors the
 * bracket walk the canonical parser uses for image-code retention.
 */
function findRevocableImageCode(
  text: string,
  regions: ReadonlyArray<{ start: number; end: number; block: boolean }>,
  keptTokens: readonly CodeSpan[],
): boolean {
  if (keptTokens.length === 0) {
    return false;
  }
  const isRevoked = (ranges: readonly CodeSpan[]) =>
    ranges.some((range) =>
      keptTokens.some((token) => token.start < range.end && token.end > range.start),
    );
  const brackets: Array<{ image: boolean; ranges: CodeSpan[] }> = [];
  // The `(`…`)` destination/title that follows an image label is part of the image
  // syntax, so code spans inside it lose ownership when its closing paren completes.
  let tail: { ranges: CodeSpan[] } | undefined;
  let tailDepth = 0;
  let regionIndex = 0;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const region = regions[regionIndex];
    if (region?.start === cursor) {
      if (!region.block) {
        const span = { start: region.start, end: region.end };
        if (tail) {
          tail.ranges.push(span);
        } else {
          for (const bracket of brackets) {
            if (bracket.image) {
              bracket.ranges.push(span);
            }
          }
        }
      }
      cursor = region.end - 1;
      regionIndex += 1;
      continue;
    }
    const char = text[cursor];
    if (tail) {
      if (char === "\\") {
        cursor += 1;
      } else if (char === "(") {
        tailDepth += 1;
      } else if (char === ")") {
        tailDepth -= 1;
        if (tailDepth === 0) {
          if (isRevoked(tail.ranges)) {
            return true;
          }
          tail = undefined;
        }
      }
      continue;
    }
    if (char === "\\") {
      cursor += 1;
    } else if (char === "!" && text[cursor + 1] === "[") {
      brackets.push({ image: true, ranges: [] });
      cursor += 1;
    } else if (char === "[") {
      brackets.push({ image: false, ranges: [] });
    } else if (char === "]") {
      const bracket = brackets.pop();
      if (bracket?.image) {
        if (isRevoked(bracket.ranges)) {
          return true;
        }
        if (text[cursor + 1] === "(") {
          tail = { ranges: [] };
          tailDepth = 1;
          cursor += 1;
        }
      }
    }
  }
  if (tail && isRevoked(tail.ranges)) {
    return true;
  }
  return brackets.some((bracket) => bracket.image && isRevoked(bracket.ranges));
}

type ReferenceDefinition = { identifier: string; start: number; end: number };

/** Blank-line boundary the canonical ownership parser uses to settle reference definitions. */
function findLastBlankLine(text: string): number {
  let lastBlank = -1;
  for (const blank of text.matchAll(/(?:\r\n|\n|\r(?!\n))[ \t]*(?:\r\n|\n|\r(?!\n))/g)) {
    lastBlank = blank.index;
  }
  return lastBlank;
}

function wrappedInBackticks(text: string, token: CodeSpan, start: number, end: number): boolean {
  if (token.start < start || token.end > end) {
    return false;
  }
  if (text.lastIndexOf("`", token.start) < start) {
    return false;
  }
  const close = text.indexOf("`", token.end);
  return close !== -1 && close < end;
}

/**
 * Visits each image-syntax range (label content, reference label, and destination/title)
 * in order. Code regions are skipped, so markup inside code is not image syntax.
 */
function walkImageSyntax(
  text: string,
  regions: ReadonlyArray<{ start: number; end: number; block: boolean }>,
  visit: (start: number, end: number) => boolean,
): boolean {
  const brackets: Array<{ image: boolean; start: number }> = [];
  let tail: { start: number } | undefined;
  let tailDepth = 0;
  let regionIndex = 0;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const region = regions[regionIndex];
    if (region?.start === cursor) {
      cursor = region.end - 1;
      regionIndex += 1;
      continue;
    }
    const char = text[cursor];
    if (tail) {
      if (char === "\\") {
        cursor += 1;
      } else if (char === "(") {
        tailDepth += 1;
      } else if (char === ")") {
        tailDepth -= 1;
        if (tailDepth === 0) {
          if (visit(tail.start, cursor)) {
            return true;
          }
          tail = undefined;
        }
      }
      continue;
    }
    if (char === "\\") {
      cursor += 1;
    } else if (char === "!" && text[cursor + 1] === "[") {
      brackets.push({ image: true, start: cursor + 2 });
      cursor += 1;
    } else if (char === "[") {
      brackets.push({ image: false, start: cursor + 1 });
    } else if (char === "]") {
      const bracket = brackets.pop();
      if (bracket?.image) {
        const reference = text.indexOf("]", cursor + 2);
        const end =
          text[cursor + 1] === "[" ? (reference === -1 ? text.length - 1 : reference) : cursor;
        if (visit(bracket.start, end + 1)) {
          return true;
        }
        if (text[cursor + 1] === "(") {
          tail = { start: cursor + 2 };
          tailDepth = 1;
          cursor += 1;
        }
      }
    }
  }
  if (tail && visit(tail.start, text.length)) {
    return true;
  }
  return brackets.some((bracket) => bracket.image && visit(bracket.start, text.length));
}

/**
 * Reference definitions can gain or lose their ownership while the canonical parser still
 * has no blank-line boundary after them: a same-line suffix can invalidate a definition and
 * restore, or newly strip, the tokens the batch transform keeps or removes there. Streamed
 * appends cannot be trusted until that boundary settles, in either direction.
 */
function findUnsettledReferenceCode(
  text: string,
  regions: ReadonlyArray<{ start: number; end: number; block: boolean }>,
  keptTokens: readonly CodeSpan[],
  strippedTokens: readonly CodeSpan[],
  definitions: readonly ReferenceDefinition[],
  textSpans: ReadonlyArray<readonly [number, number]>,
): boolean {
  const lastBlank = findLastBlankLine(text);
  const textStarts = new Set(textSpans.map(([start]) => start));
  if (strippedTokens.length > 0) {
    const unsettled = definitions.filter((definition) => definition.end > lastBlank);
    for (const definition of unsettled) {
      for (const token of strippedTokens) {
        if (wrappedInBackticks(text, token, definition.start, definition.end)) {
          return true;
        }
      }
    }
    if (
      unsettled.length > 0 &&
      walkImageSyntax(text, regions, (start, end) =>
        strippedTokens.some((token) => wrappedInBackticks(text, token, start, end)),
      )
    ) {
      return true;
    }
  }
  for (const token of keptTokens) {
    const open = text.lastIndexOf("[", token.start);
    if (open < 0 || open <= lastBlank || text[open - 1] === "\\" || text[open - 1] === "!") {
      continue;
    }
    // The block parser owns container-prefix normalization, including quotes and list items.
    if (!textStarts.has(open)) {
      continue;
    }
    const close = text.indexOf("]", open + 1);
    if (close !== -1 && close < token.end) {
      continue;
    }
    // A closed label is still undecided while the next character can still make it a
    // definition: only `]:` strips the label tokens, and the next character may not
    // have arrived yet.
    if (close === -1 || close + 1 >= text.length || text[close + 1] === ":") {
      return true;
    }
  }
  return false;
}

type ProjectedTokenText = { text: string; referenceCodeRisk: boolean };

function projectModelSpecialTokens(text: string): ProjectedTokenText {
  if (!text) {
    return { text, referenceCodeRisk: false };
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return { text, referenceCodeRisk: false };
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;

  const ownership = /[`~\t]| {4}/u.test(text)
    ? findCodeOwnership(text, { includeText: true })
    : undefined;
  const codeRegions = ownership?.regions ?? [];
  const keptTokens: CodeSpan[] = [];
  const strippedTokens: CodeSpan[] = [];
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(MODEL_SPECIAL_TOKEN_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    const end = start + matched.length;
    out += text.slice(cursor, start);
    if (codeRegions.some((region) => start < region.end && end > region.start)) {
      out += matched;
      keptTokens.push({ start, end });
    } else {
      strippedTokens.push({ start, end });
      if (
        // Retained text handles adjacent tokens; two code units preserve astral letters.
        // Keep alternation: Node 26.5's V8 misses astral letters in `$`-anchored `u` classes.
        // A following combining mark stays attached, and punctuation needs no separator.
        /(?:\p{L}|\p{M}|\p{N})$/u.test(out.slice(-2)) &&
        /^[\p{L}\p{N}]/u.test(text.slice(end, end + 2))
      ) {
        out += " ";
      }
    }
    cursor = end;
  }
  out += text.slice(cursor);
  const referenceCodeRisk =
    ownership !== undefined &&
    (findRevocableImageCode(text, codeRegions, keptTokens) ||
      findUnsettledReferenceCode(
        text,
        codeRegions,
        keptTokens,
        strippedTokens,
        ownership.definitions,
        ownership.textSpans,
      ));
  return { text: out, referenceCodeRisk };
}

/**
 * Strips leaked model control tokens like `<|assistant|>` or full-width pipe variants.
 * Code examples are preserved; remove this when providers stop emitting these tokens.
 *
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
export function stripModelSpecialTokens(text: string): string {
  return projectModelSpecialTokens(text).text;
}

/**
 * Streams the same stripping without re-parsing the settled prefix after a leak. Once a
 * token has appeared, deltas that cannot start or complete one append directly; the
 * canonical transform only runs for an unstable tail, a token-ending separator, a backtick
 * delta, a fence-capable tilde run that can change whether an earlier token is code-owned,
 * while a kept token still depends on image syntax that a later character can resolve,
 * or while a reference definition can still gain or lose the ownership of a token.
 */
export function createModelSpecialTokenProjector(): (input: TextProjection) => TextProjection {
  let inputLength = 0;
  let output = "";
  let active = false;
  let activationTail = "";
  let pendingPrefix = false;
  // A removed token at the end decides its separator only once the next character is complete.
  let separatorPending = false;
  // Only a 3+ tilde run can open or close a fence, so a split run carries two characters.
  let tildeCarry = "";
  // Image syntax or an unsettled reference definition can still change token ownership.
  let referenceCodeRisk = false;

  const projectFull = (text: string, delta: string | null): TextProjection => {
    inputLength = text.length;
    const projected = projectModelSpecialTokens(text);
    const next = projected.text;
    referenceCodeRisk = projected.referenceCodeRisk;
    const nextDelta =
      delta === null ? null : next.startsWith(output) ? next.slice(output.length) : null;
    output = next;
    active ||= TOKEN_START_RE.test(text);
    activationTail = text.slice(-1);
    pendingPrefix = endsWithIncompleteTokenPrefix(text);
    separatorPending =
      endsWithCompleteToken(text) ||
      endsWithTokenBeforeIncompleteSurrogate(text) ||
      (separatorPending && /[\uD800-\uDBFF]$/u.test(text));
    tildeCarry = text.slice(-2);
    return { text: next, delta: nextDelta };
  };

  return (input) => {
    if (input.delta === null) {
      return projectFull(input.text, null);
    }
    const appended = input.delta;
    if (input.text.length !== inputLength + appended.length) {
      // A prepared snapshot replaced the source instead of extending it.
      return projectFull(input.text, appended);
    }
    if (!active) {
      const windowText = activationTail + appended;
      active = TOKEN_START_RE.test(windowText);
      activationTail = windowText.slice(-1);
      if (!active) {
        inputLength = input.text.length;
        output = input.text;
        return input;
      }
      // The opener can start in retained text, so the canonical transform owns this delta.
      return projectFull(input.text, appended);
    }
    const changesCodeOwnership =
      appended.includes("`") || appended.includes("~~~") || (tildeCarry + appended).includes("~~~");
    if (
      referenceCodeRisk ||
      pendingPrefix ||
      separatorPending ||
      TOKEN_START_RE.test(appended) ||
      changesCodeOwnership
    ) {
      return projectFull(input.text, appended);
    }
    inputLength = input.text.length;
    output += appended;
    pendingPrefix = appended.endsWith("<");
    tildeCarry = input.text.slice(-2);
    return { text: output, delta: appended };
  };
}

/** Delivery filter: batch parity through `transform`, bounded work through `create`. */
export const modelSpecialTokensTextFilter: TextFilter = {
  transform: stripModelSpecialTokens,
  create: createModelSpecialTokenProjector,
};
