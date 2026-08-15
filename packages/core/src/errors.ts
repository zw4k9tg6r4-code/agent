export class AgentCoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentCoreError";
    this.code = code;
  }
}
