import { isRecord } from "../../../config/legacy.shared.js";

export { isRecord };

/**
 * Converts an unknown value to a trimmed non-empty string, or undefined.
 * Returns undefined for non-strings, empty strings, or whitespace-only strings.
 */
export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Formats match metadata into a string like "matchKey=123 matchSource=foo".
 * - matchKey: accepts non-empty strings or finite numbers
 * - matchSource: accepts non-empty strings only
 * Returns undefined if both fields are empty/invalid.
 */
export function formatMatchMetadata(params: {
  matchKey?: unknown;
  matchSource?: unknown;
}): string | undefined {
  const matchKey = formatMatchKeyValue(params.matchKey);
  const matchSource = asString(params.matchSource);
  const parts = [matchKey, matchSource].filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Formats a matchKey value: accepts non-empty strings or finite numbers.
 * Returns undefined for invalid/empty values.
 */
function formatMatchKeyValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? `matchKey=${trimmed}` : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `matchKey=${value}`;
  }
  return undefined;
}

export function appendMatchMetadata(
  message: string,
  params: { matchKey?: unknown; matchSource?: unknown },
): string {
  const meta = formatMatchMetadata(params);
  return meta ? `${message} (${meta})` : message;
}
