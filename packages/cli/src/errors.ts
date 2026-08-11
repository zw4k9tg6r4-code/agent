export const EXIT_CODES = {
  success: 0,
  runtimeFailure: 1,
  usageOrConfig: 2,
  cancelled: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type CliErrorCode =
  | "CONFIG_ERROR"
  | "DATA_ERROR"
  | "SESSION_BUSY"
  | "SESSION_NOT_FOUND"
  | "USAGE_ERROR";

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: ExitCode;

  constructor(code: CliErrorCode, exitCode: ExitCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
