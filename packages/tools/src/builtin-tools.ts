import type {
  Tool,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "@agent/contracts";

import {
  BUILTIN_TOOL_DEFINITIONS,
  FILE_PATCH_DEFINITION,
  FILE_READ_DEFINITION,
  FILE_SEARCH_DEFINITION,
  SHELL_EXECUTE_DEFINITION,
} from "./definitions.js";
import { runFilePatch } from "./file-patch.js";
import { runFileRead } from "./file-read.js";
import { runFileSearch } from "./file-search.js";
import { runShellExecute } from "./shell-execute.js";
import { toolFailure } from "./tool-result.js";

type ToolRunner = (
  call: ToolCall,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

function createTool(
  definition: ToolDefinition,
  runner: ToolRunner,
): Tool {
  return {
    definition,
    async execute(
      call: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      if (call.name !== definition.name) {
        return toolFailure(
          call,
          "TOOL_IDENTITY_MISMATCH",
          `call for ${call.name} reached ${definition.name}`,
        );
      }
      return runner(call, context);
    },
  };
}

export function createBuiltinTools(): readonly Tool[] {
  const tools = [
    createTool(FILE_READ_DEFINITION, runFileRead),
    createTool(FILE_SEARCH_DEFINITION, runFileSearch),
    createTool(FILE_PATCH_DEFINITION, runFilePatch),
    createTool(SHELL_EXECUTE_DEFINITION, runShellExecute),
  ];
  if (
    tools.some(
      (tool, index) =>
        tool.definition !== BUILTIN_TOOL_DEFINITIONS[index],
    )
  ) {
    throw new Error("built-in tool order does not match definitions");
  }
  return Object.freeze(tools);
}
