import { describe, expect, expectTypeOf, it } from "vitest";

import {
  isPermissionMode,
  PERMISSION_MODES,
  type PermissionConfirmer,
  type PermissionEvaluator,
  type PermissionDecision,
} from "../src/index.js";

describe("permission contracts", () => {
  it("publishes all supported permission modes", () => {
    expect(PERMISSION_MODES).toEqual([
      "readonly",
      "workspace",
      "trusted",
    ]);
  });

  it("validates permission modes without accepting unknown values", () => {
    expect(isPermissionMode("workspace")).toBe(true);
    expect(isPermissionMode("admin")).toBe(false);
  });

  it("defines an asynchronous evaluator", () => {
    expectTypeOf<PermissionEvaluator["evaluate"]>().returns.toEqualTypeOf<
      Promise<PermissionDecision>
    >();
    expectTypeOf<PermissionConfirmer["confirm"]>().returns.toEqualTypeOf<
      Promise<boolean>
    >();
  });

  it("requires resolved arguments for executable decisions", () => {
    const decision: PermissionDecision = {
      outcome: "allow",
      reason: "path is inside the workspace",
      ruleId: "workspace.path.inside",
      resolvedArguments: {
        path: "C:/workspace/README.md",
      },
    };

    expect(decision.resolvedArguments["path"]).toBe(
      "C:/workspace/README.md",
    );
  });
});
