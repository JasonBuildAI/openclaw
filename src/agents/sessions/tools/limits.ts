import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

export const WRITE_DIFF_MAX_BYTES = 1024 * 1024;

/**
 * Largest source the read tool materializes for one call. The tool only returns
 * a bounded page, so files beyond this window are read up to the limit and the
 * caller is told to use `exec` for later ranges instead of loading the file.
 */
export const READ_SOURCE_MAX_BYTES = 16 * 1024 * 1024;

/** Normalizes optional positive numeric limits to a finite integer. */
export function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return resolveIntegerOption(value, fallback, { min: 1 });
}
