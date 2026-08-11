const TRUNCATION_MARKER = "\n...[output truncated]...\n";
const MINIMUM_LIMIT_BYTES = 32;

export interface TruncatedText {
  readonly output: string;
  readonly originalBytes: number;
  readonly outputBytes: number;
  readonly truncated: boolean;
}

function takeStartByBytes(text: string, budget: number): string {
  let used = 0;
  let result = "";

  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > budget) {
      break;
    }
    result += character;
    used += bytes;
  }

  return result;
}

function takeEndByBytes(text: string, budget: number): string {
  const characters = Array.from(text);
  let used = 0;
  let result = "";

  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    if (character === undefined) {
      continue;
    }
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > budget) {
      break;
    }
    result = character + result;
    used += bytes;
  }

  return result;
}

export function truncateUtf8(
  text: string,
  limitBytes: number,
): TruncatedText {
  if (!Number.isInteger(limitBytes) || limitBytes < MINIMUM_LIMIT_BYTES) {
    throw new RangeError("limitBytes must be an integer of at least 32");
  }

  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= limitBytes) {
    return {
      output: text,
      originalBytes,
      outputBytes: originalBytes,
      truncated: false,
    };
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const contentBudget = limitBytes - markerBytes;
  const prefixBudget = Math.ceil(contentBudget * 0.6);
  const suffixBudget = contentBudget - prefixBudget;
  const output =
    takeStartByBytes(text, prefixBudget) +
    TRUNCATION_MARKER +
    takeEndByBytes(text, suffixBudget);

  return {
    output,
    originalBytes,
    outputBytes: Buffer.byteLength(output, "utf8"),
    truncated: true,
  };
}
