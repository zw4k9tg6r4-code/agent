import type {
  JsonObject,
  ToolCall,
  ToolFailure,
  ToolSuccess,
} from "@agent/contracts";

export function toolFailure(
  call: ToolCall,
  code: string,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly output?: string;
    readonly metadata?: JsonObject;
  } = {},
): ToolFailure {
  const result: ToolFailure = {
    toolCallId: call.id,
    ok: false,
    output: options.output ?? "",
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
    },
    ...(options.metadata === undefined
      ? {}
      : { metadata: options.metadata }),
  };
  return result;
}

export function toolSuccess(
  call: ToolCall,
  output: string,
  metadata?: JsonObject,
): ToolSuccess {
  return metadata === undefined
    ? {
        toolCallId: call.id,
        ok: true,
        output,
      }
    : {
        toolCallId: call.id,
        ok: true,
        output,
        metadata,
      };
}
