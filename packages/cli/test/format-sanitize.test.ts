import { describe, expect, it } from "vitest";
import { sanitizeTerminal, stripAnsi } from "../src/format.js";

describe("Terminal Output Sanitization", () => {
  it("strips SGR color codes", () => {
    const input = "\x1b[31mRed Text\x1b[0m and \x1b[1;34mBold Blue\x1b[0m";
    expect(stripAnsi(input)).toBe("Red Text and Bold Blue");
  });

  it("strips OSC window title and hyperlink sequences", () => {
    const oscTitle = "\x1b]0;Evil Window Title\x07Hello World";
    expect(sanitizeTerminal(oscTitle)).toBe("Hello World");

    const oscEscTerminated = "\x1b]8;;http://malicious.link\x1b\\Click Me\x1b]8;;\x1b\\";
    expect(sanitizeTerminal(oscEscTerminated)).toBe("Click Me");
  });

  it("strips DCS device control strings", () => {
    const dcs = "\x1bP1$tx+y\x1b\\Clean Text";
    expect(sanitizeTerminal(dcs)).toBe("Clean Text");
  });

  it("strips non-printable C0 and C1 control characters but preserves tabs and newlines", () => {
    const raw = "Line 1\x00\x07\x08\tTabbed\nLine 2\r\nLine 3\x7f\x80\x9f";
    const cleaned = sanitizeTerminal(raw);
    expect(cleaned).toBe("Line 1\tTabbed\nLine 2\r\nLine 3");
  });
});
