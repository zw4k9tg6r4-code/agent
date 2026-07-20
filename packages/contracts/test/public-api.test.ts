import { describe, expect, it } from "vitest";

import { CONTRACTS_VERSION } from "../src/index.js";

describe("@agent/contracts public API", () => {
  it("exposes the initial contract version", () => {
    expect(CONTRACTS_VERSION).toBe(1);
  });
});
