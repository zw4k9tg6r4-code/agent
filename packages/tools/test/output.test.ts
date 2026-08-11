import { describe, expect, it } from "vitest";

import { truncateUtf8 } from "../src/index.js";

describe("truncateUtf8", () => {
  it("returns short text unchanged", () => {
    expect(truncateUtf8("hello", 64)).toEqual({
      output: "hello",
      originalBytes: 5,
      outputBytes: 5,
      truncated: false,
    });
  });

  it("keeps the prefix, suffix, marker, and byte limit", () => {
    const result = truncateUtf8(
      `BEGIN-${"中".repeat(80)}-END`,
      96,
    );

    expect(result.truncated).toBe(true);
    expect(result.output.startsWith("BEGIN-")).toBe(true);
    expect(result.output.endsWith("-END")).toBe(true);
    expect(result.output).toContain("...[output truncated]...");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(96);
    expect(result.output).not.toContain("\uFFFD");
  });

  it("rejects unusable byte limits", () => {
    expect(() => truncateUtf8("hello", 31)).toThrow(
      "limitBytes must be an integer of at least 32",
    );
  });
});
